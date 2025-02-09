/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {createAsExpression, createEnumDeclaration, createIdentifier, createIntersectionTypeNode, createLiteralTypeNode, createModifiersFromModifierFlags, createObjectLiteral, createParenthesizedType, createPropertyAssignment, createStringLiteral, createTypeAliasDeclaration, createTypeLiteralNode, createTypeReferenceNode, createUnionTypeNode, createVariableDeclaration, createVariableDeclarationList, createVariableStatement, DeclarationStatement, EnumDeclaration, ModifierFlags, NodeFlags, Statement, TypeAliasDeclaration, TypeNode, VariableStatement} from 'typescript';

import {Log} from '../logging';
import {TObject, TPredicate, TSubject} from '../triples/triple';
import {UrlNode} from '../triples/types';
import {GetComment, GetSubClassOf, IsSupersededBy} from '../triples/wellKnown';

import {Context} from './context';
import {EnumValue} from './enum';
import {IdPropertyNode, Property, TypeProperty} from './property';
import {arrayOf} from './util/arrayof';
import {withComments} from './util/comments';
import {toClassName} from './util/names';

/** Maps fully qualified IDs of each Class to the class itself. */
export type ClassMap = Map<string, Class>;

/**
 * Represents a "Class" in Schema.org, except in cases where it is better
 * described by Builtin (i.e. is a DataType).
 *
 * In TypeScript, this corresponds to a collection of declarations:
 * 1. If the class has enum values, an Enum declaration.
 * 2. If the class has properties, the properties in an object literal.
 * 3. If the class has children,
 *        a type union over all children.
 *    otherwise, a "type" property.
 */
export class Class {
  private _comment?: string;
  private readonly children: Class[] = [];
  private readonly parents: Class[] = [];
  private readonly _props: Set<Property> = new Set();
  private readonly _enums: Set<EnumValue> = new Set();
  private readonly _supersededBy: Set<Class> = new Set();

  private inheritsDataType(): boolean {
    for (const parent of this.parents) {
      if (parent instanceof Builtin || parent.inheritsDataType()) {
        return true;
      }
    }
    return false;
  }

  get deprecated() {
    return this._supersededBy.size > 0;
  }

  private get comment() {
    if (!this.deprecated) return this._comment;
    const deprecated = `@deprecated Use ${
        this.supersededBy().map(c => c.className()).join(' or ')} instead.`;
    return this._comment ? `${this._comment}\n${deprecated}` : deprecated;
  }

  private properties() {
    return Array.from(this._props.values())
        .sort((a, b) => CompareKeys(a.key, b.key));
  }

  private supersededBy() {
    return Array.from(this._supersededBy)
        .sort((a, b) => CompareKeys(a.subject, b.subject));
  }

  private enums() {
    return Array.from(this._enums)
        .sort((a, b) => CompareKeys(a.value, b.value));
  }

  private get allowString(): boolean {
    return this._allowStringType ||
        this.parents.some(parent => parent.allowString);
  }

  protected baseName() {
    return toClassName(this.subject) + 'Base';
  }
  private enumName() {
    return toClassName(this.subject) + 'Enum';
  }
  private className() {
    return toClassName(this.subject);
  }

  constructor(
      readonly subject: TSubject, private readonly _allowStringType: boolean) {}
  add(value: {Predicate: TPredicate; Object: TObject},
      classMap: ClassMap): boolean {
    const c = GetComment(value);
    if (c) {
      if (this._comment) {
        Log(`Duplicate comments provided on class ${
            this.subject.toString()}. It will be overwritten.`);
      }
      this._comment = c.comment;
      return true;
    }
    const s = GetSubClassOf(value);
    if (s) {
      const parentClass = classMap.get(s.subClassOf.toString());
      if (parentClass) {
        this.parents.push(parentClass);
        parentClass.children.push(this);
      } else {
        throw new Error(`Couldn't find parent of ${this.subject.name}, ${
            s.subClassOf.toString()}`);
      }
      return true;
    }

    if (IsSupersededBy(value.Predicate)) {
      const supersededBy = classMap.get(value.Object.toString());
      if (!supersededBy) {
        throw new Error(`Couldn't find class ${
            value.Object.toString()}, which supersedes class ${
            this.subject.name}`);
      }
      this._supersededBy.add(supersededBy);
      return true;
    }

    return false;
  }
  addProp(p: Property) {
    this._props.add(p);
  }
  addEnum(e: EnumValue) {
    this._enums.add(e);
  }

  private baseNode(skipDeprecatedProperties: boolean, context: Context):
      TypeNode {
    const parentTypes = this.parents.map(
        parent => createTypeReferenceNode(parent.baseName(), []));
    const parentNode = parentTypes.length === 0 ?
        null :
        parentTypes.length === 1 ?
        parentTypes[0] :
        createParenthesizedType(createIntersectionTypeNode(parentTypes));

    const isRoot = parentNode === null;

    // Properties part.
    const propLiteral = createTypeLiteralNode([
      // Add an '@id' property for the root.
      ...(isRoot ? [IdPropertyNode()] : []),
      // ... then everything else.
      ...this.properties()
          .filter(property => !property.deprecated || !skipDeprecatedProperties)
          .map(prop => prop.toNode(context))
    ]);

    if (parentNode && propLiteral.members.length > 0) {
      return createIntersectionTypeNode([parentNode, propLiteral]);
    } else if (parentNode) {
      return parentNode;
    } else if (propLiteral.members.length > 0) {
      return propLiteral;
    } else {
      return createTypeLiteralNode([]);
    }
  }

  private baseDecl(skipDeprecatedProperties: boolean, context: Context):
      TypeAliasDeclaration {
    const baseNode = this.baseNode(skipDeprecatedProperties, context);

    return createTypeAliasDeclaration(
        /*decorators=*/[], /*modifiers=*/[], this.baseName(),
        /*typeParameters=*/[], baseNode);
  }

  private nonEnumType(context: Context): TypeNode {
    this.children.sort((a, b) => CompareKeys(a.subject, b.subject));
    const children = this.children.map(
        child =>
            createTypeReferenceNode(child.className(), /*typeArguments=*/[]));

    // 'String' is a valid Type sometimes, add that as a Child if so.
    if (this.allowString) {
      children.push(createTypeReferenceNode('string', /*typeArguments=*/[]));
    }

    const childrenNode = children.length === 0 ?
        null :
        children.length === 1 ?
        children[0] :
        createParenthesizedType(createUnionTypeNode(children));

    const baseTypeReference =
        createTypeReferenceNode(this.baseName(), /*typeArguments=*/[]);

    // If we inherit from a DataType (~= a Built In), then the type is _not_
    // represented as a node. Skip the leaf type.
    const thisType = this.inheritsDataType() ?
        baseTypeReference :
        createIntersectionTypeNode([
          createTypeLiteralNode(
              [new TypeProperty(this.subject).toNode(context)]),
          baseTypeReference
        ]);

    if (childrenNode) {
      return createUnionTypeNode([thisType, childrenNode]);
    } else {
      return thisType;
    }
  }

  private totalType(context: Context): TypeNode {
    const isEnum = this._enums.size > 0;

    if (isEnum) {
      return createUnionTypeNode([
        ...this.enums().map(e => e.toTypeLiteral()),
        createParenthesizedType(this.nonEnumType(context)),
      ]);
    } else {
      return this.nonEnumType(context);
    }
  }

  private enumDecl(): VariableStatement|undefined {
    if (this._enums.size === 0) return undefined;
    const enums = this.enums();

    return createVariableStatement(
        createModifiersFromModifierFlags(ModifierFlags.Export),
        createVariableDeclarationList(
            [createVariableDeclaration(
                this.className(),
                /*type=*/undefined,
                createObjectLiteral(
                    enums.map(e => e.toNode()), /*multiLine=*/true))],
            NodeFlags.Const));
  }

  private deprecatedEnumDecl(): Statement[] {
    if (this._enums.size === 0) return [];
    return [
      withComments(
          `@deprecated Use ${this.className()} as a variable instead.`,
          createVariableStatement(
              createModifiersFromModifierFlags(ModifierFlags.Export),
              createVariableDeclarationList(
                  [createVariableDeclaration(
                      this.enumName(),
                      /*type=*/undefined, createIdentifier(this.className()))],
                  NodeFlags.Const))),
      withComments(
          `@deprecated Use ${this.className()} as a type instead.`,
          createTypeAliasDeclaration(
              /* decorators = */[],
              createModifiersFromModifierFlags(ModifierFlags.Export),
              this.enumName(), /*typeParameters=*/[],
              createTypeReferenceNode(this.className(), /*typeArgs=*/[])))
    ];
  }

  toNode(context: Context, skipDeprecatedProperties: boolean):
      readonly Statement[] {
    const typeValue: TypeNode = this.totalType(context);
    const declaration = withComments(
        this.comment,
        createTypeAliasDeclaration(
            /* decorators = */[],
            createModifiersFromModifierFlags(ModifierFlags.Export),
            this.className(),
            [],
            typeValue,
            ));

    // Guide to Code Generated:
    // // Base: Always There -----------------------//
    // type XyzBase = (Parents) & {
    //   ... props;
    // };
    // // Complete Type ----------------------------//
    // export type Xyz = "Enum1"|"Enum2"|...        // Enum Piece: Optional.
    //                  |XyzBase&{'@type': 'Xyz'}   // 'Leaf' Piece.
    //                  |Child1|Child2|...          // Child Piece: Optional.
    // // Enum Values: Optional --------------------//
    // export const Xyz = {
    //   Enum1 = "Enum1" as const,
    //   Enum2 = "Enum2" as const,
    //   ...
    // }
    // // Deprecated: Old Enum Style Declarations --//
    // export const XyzEnum = Xyz;
    // export type XyzEnum = Xyz;
    // //-------------------------------------------//
    return arrayOf<Statement>(
        this.baseDecl(skipDeprecatedProperties, context),
        declaration,
        this.enumDecl(),
        ...this.deprecatedEnumDecl(),
    );
  }
}

/**
 * Represents a DataType. A "Native" Schema.org object that is best represented
 * in JSON-LD and JavaScript as a typedef to a native type.
 */
export class Builtin extends Class {
  constructor(
      url: string, private readonly equivTo: string,
      protected readonly doc: string) {
    super(UrlNode.Parse(url), false);
  }

  toNode(): readonly Statement[] {
    return [
      withComments(
          this.doc,
          createTypeAliasDeclaration(
              /*decorators=*/[],
              createModifiersFromModifierFlags(ModifierFlags.Export),
              this.subject.name,
              /*typeParameters=*/[],
              createTypeReferenceNode(this.equivTo, []))),
    ];
  }

  protected baseName() {
    return this.subject.name;
  }
}
export class BooleanEnum extends Builtin {
  constructor(
      url: string, private trueUrl: string, private falseUrl: string,
      doc: string) {
    super(url, '', doc);
  }

  toNode(): readonly Statement[] {
    return [
      withComments(
          this.doc,
          createTypeAliasDeclaration(
              /*decotrators=*/[],
              createModifiersFromModifierFlags(ModifierFlags.Export),
              this.subject.name,
              /*typeParameters=*/[],
              createUnionTypeNode([
                createTypeReferenceNode('true', /*typeArgs=*/[]),
                createTypeReferenceNode('false', /*typeArgs=*/[]),
                createLiteralTypeNode(createStringLiteral(this.trueUrl)),
                createLiteralTypeNode(createStringLiteral(this.falseUrl)),
              ]),
              )),
      createVariableStatement(
          createModifiersFromModifierFlags(ModifierFlags.Export),
          createVariableDeclarationList(
              [createVariableDeclaration(
                  this.subject.name,
                  /*type=*/undefined,
                  createObjectLiteral(
                      [
                        createPropertyAssignment(
                            'True',
                            createAsExpression(
                                createStringLiteral(this.trueUrl),
                                createTypeReferenceNode('const', undefined))),
                        createPropertyAssignment(
                            'False',
                            createAsExpression(
                                createStringLiteral(this.falseUrl),
                                createTypeReferenceNode('const', undefined))),
                      ],
                      true),
                  )],
              NodeFlags.Const))
    ];
  }
}

export class DataTypeUnion extends Builtin {
  constructor(url: string, private readonly wk: Builtin[], doc: string) {
    super(url, '', doc);
  }

  toNode(): DeclarationStatement[] {
    return [withComments(
        this.doc,
        createTypeAliasDeclaration(
            /*decorators=*/[],
            createModifiersFromModifierFlags(ModifierFlags.Export),
            this.subject.name, /*typeParameters=*/[],
            createUnionTypeNode(this.wk.map(
                wk => createTypeReferenceNode(
                    wk.subject.name, /*typeArguments=*/[])))))];
  }
}

/**
 * Defines a Sort order between Class declarations.
 *
 * DataTypes come first, by the 'DataType' union itself, followed by all regular
 * classes. Within each group, class names are ordered alphabetically in UTF-16
 * code units order.
 */
export function Sort(a: Class, b: Class): number {
  if (a instanceof Builtin && !(a instanceof DataTypeUnion)) {
    if (b instanceof Builtin && !(b instanceof DataTypeUnion)) {
      return a.subject.name.localeCompare(b.subject.name);
    } else {
      return -1;
    }
  } else if (b instanceof Builtin && !(b instanceof DataTypeUnion)) {
    return +1;
  } else if (a instanceof DataTypeUnion) {
    return b instanceof DataTypeUnion ? 0 : -1;
  } else if (b instanceof DataTypeUnion) {
    return a instanceof DataTypeUnion ? 0 : +1;
  } else {
    return CompareKeys(a.subject, b.subject);
  }
}

function CompareKeys(a: TSubject, b: TSubject): number {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;

  return a.href.localeCompare(b.href);
}
