/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {AbsoluteSourceSpan, CssSelector, ParseSourceSpan, SelectorMatcher} from '@angular/compiler';
import {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import {DeclarationNode} from '@angular/compiler-cli/src/ngtsc/reflection';
import {DirectiveSymbol} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import * as e from '@angular/compiler/src/expression_parser/ast';  // e for expression AST
import * as t from '@angular/compiler/src/render3/r3_ast';         // t for template AST
import * as ts from 'typescript';

import {ALIAS_NAME, SYMBOL_PUNC} from './display_parts';



/**
 * Return the node that most tightly encompass the specified `position`.
 * @param node
 * @param position
 */
export function findTightestNode(node: ts.Node, position: number): ts.Node|undefined {
  if (node.getStart() <= position && position < node.getEnd()) {
    return node.forEachChild(c => findTightestNode(c, position)) || node;
  }
}

/**
 * Returns a property assignment from the assignment value if the property name
 * matches the specified `key`, or `undefined` if there is no match.
 */
export function getPropertyAssignmentFromValue(value: ts.Node, key: string): ts.PropertyAssignment|
    undefined {
  const propAssignment = value.parent;
  if (!propAssignment || !ts.isPropertyAssignment(propAssignment) ||
      propAssignment.name.getText() !== key) {
    return;
  }
  return propAssignment;
}

/**
 * Given a decorator property assignment, return the ClassDeclaration node that corresponds to the
 * directive class the property applies to.
 * If the property assignment is not on a class decorator, no declaration is returned.
 *
 * For example,
 *
 * @Component({
 *   template: '<div></div>'
 *   ^^^^^^^^^^^^^^^^^^^^^^^---- property assignment
 * })
 * class AppComponent {}
 *           ^---- class declaration node
 *
 * @param propAsgnNode property assignment
 */
export function getClassDeclFromDecoratorProp(propAsgnNode: ts.PropertyAssignment):
    ts.ClassDeclaration|undefined {
  if (!propAsgnNode.parent || !ts.isObjectLiteralExpression(propAsgnNode.parent)) {
    return;
  }
  const objLitExprNode = propAsgnNode.parent;
  if (!objLitExprNode.parent || !ts.isCallExpression(objLitExprNode.parent)) {
    return;
  }
  const callExprNode = objLitExprNode.parent;
  if (!callExprNode.parent || !ts.isDecorator(callExprNode.parent)) {
    return;
  }
  const decorator = callExprNode.parent;
  if (!decorator.parent || !ts.isClassDeclaration(decorator.parent)) {
    return;
  }
  const classDeclNode = decorator.parent;
  return classDeclNode;
}

/**
 * Given the node which is the string of the inline template for a component, returns the
 * `ts.ClassDeclaration` for the component.
 */
export function getClassDeclOfInlineTemplateNode(templateStringNode: ts.Node): ts.ClassDeclaration|
    undefined {
  if (!ts.isStringLiteralLike(templateStringNode)) {
    return;
  }
  const tmplAsgn = getPropertyAssignmentFromValue(templateStringNode, 'template');
  if (!tmplAsgn) {
    return;
  }
  return getClassDeclFromDecoratorProp(tmplAsgn);
}


export function getTextSpanOfNode(node: t.Node|e.AST): ts.TextSpan {
  if (isTemplateNodeWithKeyAndValue(node)) {
    return toTextSpan(node.keySpan);
  } else if (
      node instanceof e.PropertyWrite || node instanceof e.MethodCall ||
      node instanceof e.BindingPipe || node instanceof e.PropertyRead) {
    // The `name` part of a `PropertyWrite`, `MethodCall`, and `BindingPipe` does not
    // have its own AST so there is no way to retrieve a `Symbol` for just the `name` via a specific
    // node.
    return toTextSpan(node.nameSpan);
  } else {
    return toTextSpan(node.sourceSpan);
  }
}

export function toTextSpan(span: AbsoluteSourceSpan|ParseSourceSpan): ts.TextSpan {
  let start: number, end: number;
  if (span instanceof AbsoluteSourceSpan) {
    start = span.start;
    end = span.end;
  } else {
    start = span.start.offset;
    end = span.end.offset;
  }
  return {start, length: end - start};
}

interface NodeWithKeyAndValue extends t.Node {
  keySpan: ParseSourceSpan;
  valueSpan?: ParseSourceSpan;
}

export function isTemplateNodeWithKeyAndValue(node: t.Node|e.AST): node is NodeWithKeyAndValue {
  return isTemplateNode(node) && node.hasOwnProperty('keySpan');
}

export function isTemplateNode(node: t.Node|e.AST): node is t.Node {
  // Template node implements the Node interface so we cannot use instanceof.
  return node.sourceSpan instanceof ParseSourceSpan;
}

export function isExpressionNode(node: t.Node|e.AST): node is e.AST {
  return node instanceof e.AST;
}

export interface TemplateInfo {
  template: t.Node[];
  component: ts.ClassDeclaration;
}

/**
 * Retrieves the `ts.ClassDeclaration` at a location along with its template nodes.
 */
export function getTemplateInfoAtPosition(
    fileName: string, position: number, compiler: NgCompiler): TemplateInfo|undefined {
  if (isTypeScriptFile(fileName)) {
    return getTemplateInfoFromClassMeta(fileName, position, compiler);
  } else {
    return getFirstComponentForTemplateFile(fileName, compiler);
  }
}


/**
 * First, attempt to sort component declarations by file name.
 * If the files are the same, sort by start location of the declaration.
 */
function tsDeclarationSortComparator(a: DeclarationNode, b: DeclarationNode): number {
  const aFile = a.getSourceFile().fileName;
  const bFile = b.getSourceFile().fileName;
  if (aFile < bFile) {
    return -1;
  } else if (aFile > bFile) {
    return 1;
  } else {
    return b.getFullStart() - a.getFullStart();
  }
}

function getFirstComponentForTemplateFile(fileName: string, compiler: NgCompiler): TemplateInfo|
    undefined {
  const templateTypeChecker = compiler.getTemplateTypeChecker();
  const components = compiler.getComponentsWithTemplateFile(fileName);
  const sortedComponents = Array.from(components).sort(tsDeclarationSortComparator);
  for (const component of sortedComponents) {
    if (!ts.isClassDeclaration(component)) {
      continue;
    }
    const template = templateTypeChecker.getTemplate(component);
    if (template === null) {
      continue;
    }
    return {template, component};
  }

  return undefined;
}

/**
 * Retrieves the `ts.ClassDeclaration` at a location along with its template nodes.
 */
function getTemplateInfoFromClassMeta(
    fileName: string, position: number, compiler: NgCompiler): TemplateInfo|undefined {
  const classDecl = getClassDeclForInlineTemplateAtPosition(fileName, position, compiler);
  if (!classDecl || !classDecl.name) {  // Does not handle anonymous class
    return;
  }
  const template = compiler.getTemplateTypeChecker().getTemplate(classDecl);
  if (template === null) {
    return;
  }

  return {template, component: classDecl};
}

function getClassDeclForInlineTemplateAtPosition(
    fileName: string, position: number, compiler: NgCompiler): ts.ClassDeclaration|undefined {
  const sourceFile = compiler.getNextProgram().getSourceFile(fileName);
  if (!sourceFile) {
    return undefined;
  }
  const node = findTightestNode(sourceFile, position);
  if (!node) return;
  return getClassDeclOfInlineTemplateNode(node);
}

/**
 * Given an attribute node, converts it to string form.
 */
function toAttributeString(attribute: t.TextAttribute|t.BoundAttribute|t.BoundEvent): string {
  if (attribute instanceof t.BoundEvent) {
    return `[${attribute.name}]`;
  } else {
    return `[${attribute.name}=${attribute.valueSpan?.toString() ?? ''}]`;
  }
}

function getNodeName(node: t.Template|t.Element): string {
  return node instanceof t.Template ? node.tagName : node.name;
}

/**
 * Given a template or element node, returns all attributes on the node.
 */
function getAttributes(node: t.Template|
                       t.Element): Array<t.TextAttribute|t.BoundAttribute|t.BoundEvent> {
  const attributes: Array<t.TextAttribute|t.BoundAttribute|t.BoundEvent> =
      [...node.attributes, ...node.inputs, ...node.outputs];
  if (node instanceof t.Template) {
    attributes.push(...node.templateAttrs);
  }
  return attributes;
}

/**
 * Given two `Set`s, returns all items in the `left` which do not appear in the `right`.
 */
function difference<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const dir of left) {
    if (!right.has(dir)) {
      result.add(dir);
    }
  }
  return result;
}

/**
 * Given an element or template, determines which directives match because the tag is present. For
 * example, if a directive selector is `div[myAttr]`, this would match div elements but would not if
 * the selector were just `[myAttr]`. We find which directives are applied because of this tag by
 * elimination: compare the directive matches with the tag present against the directive matches
 * without it. The difference would be the directives which match because the tag is present.
 *
 * @param element The element or template node that the attribute/tag is part of.
 * @param directives The list of directives to match against.
 * @returns The list of directives matching the tag name via the strategy described above.
 */
// TODO(atscott): Add unit tests for this and the one for attributes
export function getDirectiveMatchesForElementTag(
    element: t.Template|t.Element, directives: DirectiveSymbol[]): Set<DirectiveSymbol> {
  const attributes = getAttributes(element);
  const allAttrs = attributes.map(toAttributeString);
  const allDirectiveMatches =
      getDirectiveMatchesForSelector(directives, getNodeName(element) + allAttrs.join(''));
  const matchesWithoutElement = getDirectiveMatchesForSelector(directives, allAttrs.join(''));
  return difference(allDirectiveMatches, matchesWithoutElement);
}

/**
 * Given an attribute name, determines which directives match because the attribute is present. We
 * find which directives are applied because of this attribute by elimination: compare the directive
 * matches with the attribute present against the directive matches without it. The difference would
 * be the directives which match because the attribute is present.
 *
 * @param name The name of the attribute
 * @param hostNode The node which the attribute appears on
 * @param directives The list of directives to match against.
 * @returns The list of directives matching the tag name via the strategy described above.
 */
export function getDirectiveMatchesForAttribute(
    name: string, hostNode: t.Template|t.Element,
    directives: DirectiveSymbol[]): Set<DirectiveSymbol> {
  const attributes = getAttributes(hostNode);
  const allAttrs = attributes.map(toAttributeString);
  const allDirectiveMatches =
      getDirectiveMatchesForSelector(directives, getNodeName(hostNode) + allAttrs.join(''));
  const attrsExcludingName = attributes.filter(a => a.name !== name).map(toAttributeString);
  const matchesWithoutAttr = getDirectiveMatchesForSelector(
      directives, getNodeName(hostNode) + attrsExcludingName.join(''));
  return difference(allDirectiveMatches, matchesWithoutAttr);
}

/**
 * Given a list of directives and a text to use as a selector, returns the directives which match
 * for the selector.
 */
function getDirectiveMatchesForSelector(
    directives: DirectiveSymbol[], selector: string): Set<DirectiveSymbol> {
  const selectors = CssSelector.parse(selector);
  if (selectors.length === 0) {
    return new Set();
  }
  return new Set(directives.filter((dir: DirectiveSymbol) => {
    if (dir.selector === null) {
      return false;
    }

    const matcher = new SelectorMatcher();
    matcher.addSelectables(CssSelector.parse(dir.selector));

    return selectors.some(selector => matcher.match(selector, null));
  }));
}

/**
 * Returns a new `ts.SymbolDisplayPart` array which has the alias imports from the tcb filtered
 * out, i.e. `i0.NgForOf`.
 */
export function filterAliasImports(displayParts: ts.SymbolDisplayPart[]): ts.SymbolDisplayPart[] {
  const tcbAliasImportRegex = /i\d+/;
  function isImportAlias(part: {kind: string, text: string}) {
    return part.kind === ALIAS_NAME && tcbAliasImportRegex.test(part.text);
  }
  function isDotPunctuation(part: {kind: string, text: string}) {
    return part.kind === SYMBOL_PUNC && part.text === '.';
  }

  return displayParts.filter((part, i) => {
    const previousPart = displayParts[i - 1];
    const nextPart = displayParts[i + 1];

    const aliasNameFollowedByDot =
        isImportAlias(part) && nextPart !== undefined && isDotPunctuation(nextPart);
    const dotPrecededByAlias =
        isDotPunctuation(part) && previousPart !== undefined && isImportAlias(previousPart);

    return !aliasNameFollowedByDot && !dotPrecededByAlias;
  });
}

export function isDollarEvent(n: t.Node|e.AST): n is e.PropertyRead {
  return n instanceof e.PropertyRead && n.name === '$event' &&
      n.receiver instanceof e.ImplicitReceiver && !(n.receiver instanceof e.ThisReceiver);
}

/**
 * Returns a new array formed by applying a given callback function to each element of the array,
 * and then flattening the result by one level.
 */
export function flatMap<T, R>(items: T[]|readonly T[], f: (item: T) => R[] | readonly R[]): R[] {
  const results: R[] = [];
  for (const x of items) {
    results.push(...f(x));
  }
  return results;
}

export function isTypeScriptFile(fileName: string): boolean {
  return fileName.endsWith('.ts');
}

export function isExternalTemplate(fileName: string): boolean {
  return !isTypeScriptFile(fileName);
}
