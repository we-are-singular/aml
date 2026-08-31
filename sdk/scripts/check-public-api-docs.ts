import { isAbsolute, relative, resolve, sep } from "node:path"

import ts from "@typescript/typescript6"

/** One undocumented declaration or member found on the public SDK type graph. */
export interface DocumentationIssue {
  /** Human-readable public path to the undocumented declaration. */
  readonly label: string

  /** Workspace-relative source location of the declaration. */
  readonly location: string
}

/**
 * Audits exported declarations and every locally owned type reachable from them.
 *
 * External declaration files remain owned by their dependencies. Local type
 * references and inheritance are followed recursively with cycle protection so
 * a documented public property cannot conceal an undocumented nested shape.
 */
export class PublicApiDocumentationChecker {
  readonly #checkedDeclarations = new Set<ts.Node>()
  readonly #checkedTypes = new Set<ts.TypeNode>()
  readonly #issues: DocumentationIssue[] = []
  readonly #program: ts.Program
  readonly #typeChecker: ts.TypeChecker
  readonly #workspaceDirectory: string

  /** Creates one checker for a configured TypeScript program. */
  constructor(program: ts.Program, workspaceDirectory: string) {
    this.#program = program
    this.#typeChecker = program.getTypeChecker()
    this.#workspaceDirectory = workspaceDirectory
  }

  /** Returns every documentation issue reachable from the supplied entrypoints. */
  check(entrypoints: readonly string[]): readonly DocumentationIssue[] {
    for (const entrypoint of entrypoints) {
      const source = this.#program.getSourceFile(entrypoint)

      if (source === undefined) {
        throw new Error(`Public API documentation check could not load ${entrypoint}`)
      }

      const module = this.#typeChecker.getSymbolAtLocation(source)

      if (module === undefined) {
        throw new Error(`Public API documentation check could not resolve ${entrypoint}`)
      }

      for (const exported of this.#typeChecker.getExportsOfModule(module)) {
        const resolved = this.#resolveSymbol(exported)
        const declarations = resolved.getDeclarations() ?? exported.getDeclarations() ?? []

        for (const declaration of declarations) {
          this.#checkDeclaration(declaration, exported.name, declarations)
        }
      }
    }

    return Object.freeze(
      [...this.#issues].sort(
        (left, right) => left.location.localeCompare(right.location) || left.label.localeCompare(right.label)
      )
    )
  }

  #checkDeclaration(
    declaration: ts.Declaration,
    label: string,
    siblingDeclarations: readonly ts.Declaration[] = []
  ): void {
    if (this.#checkedDeclarations.has(declaration) || isOverloadImplementation(declaration, siblingDeclarations)) {
      return
    }

    this.#checkedDeclarations.add(declaration)
    this.#requireDocumentation(declaration, label)
    this.#checkTypeParameters(declaration, label)

    if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      for (const heritageClause of declaration.heritageClauses ?? []) {
        for (const heritageType of heritageClause.types) {
          for (const typeArgument of heritageType.typeArguments ?? []) {
            this.#checkType(typeArgument, `${label} base`)
          }
          this.#checkReferencedNode(heritageType.expression, `${label} base`)
        }
      }

      for (const member of declaration.members) {
        if (!isPublicMember(member)) continue
        this.#checkMember(member, `${label}.${memberName(member)}`, declaration.members)
      }
      return
    }

    if (ts.isEnumDeclaration(declaration)) {
      for (const member of declaration.members) {
        this.#requireDocumentation(member, `${label}.${member.name.getText()}`)
      }
      return
    }

    if (ts.isTypeAliasDeclaration(declaration)) {
      this.#checkType(declaration.type, label)
      return
    }

    if (ts.isModuleDeclaration(declaration) && declaration.body !== undefined) {
      this.#checkModuleBody(declaration.body, label)
      return
    }

    if (ts.isFunctionDeclaration(declaration)) {
      for (const parameter of declaration.parameters) {
        if (parameter.type !== undefined) this.#checkType(parameter.type, `${label} parameter`)
      }
      if (declaration.type !== undefined) this.#checkType(declaration.type, `${label} result`)
      return
    }

    if (ts.isVariableDeclaration(declaration) && declaration.type !== undefined) {
      this.#checkType(declaration.type, label)
    }
  }

  #checkModuleBody(body: ts.ModuleBody, label: string): void {
    if (ts.isModuleDeclaration(body)) {
      this.#checkDeclaration(body, `${label}.${body.name.getText()}`)
      return
    }

    if (!ts.isModuleBlock(body)) return

    for (const statement of body.statements) {
      if (!isExported(statement)) continue

      if (
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      ) {
        this.#checkDeclaration(statement, `${label}.${declarationName(statement)}`)
        continue
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          this.#checkDeclaration(declaration, `${label}.${declaration.name.getText()}`)
        }
      }
    }
  }

  #checkMember(
    member: ts.ClassElement | ts.TypeElement,
    label: string,
    siblings: readonly (ts.ClassElement | ts.TypeElement)[]
  ): void {
    if (isOverloadImplementation(member, siblings)) return

    this.#requireDocumentation(member, label)
    this.#checkTypeParameters(member, label)

    if (
      ts.isCallSignatureDeclaration(member) ||
      ts.isConstructSignatureDeclaration(member) ||
      ts.isConstructorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isMethodSignature(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      for (const parameter of member.parameters) {
        if (parameter.type !== undefined) this.#checkType(parameter.type, `${label} parameter`)
      }
    }

    if (
      (ts.isCallSignatureDeclaration(member) ||
        ts.isConstructSignatureDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isIndexSignatureDeclaration(member) ||
        ts.isMethodDeclaration(member) ||
        ts.isMethodSignature(member) ||
        ts.isPropertyDeclaration(member) ||
        ts.isPropertySignature(member)) &&
      member.type !== undefined
    ) {
      this.#checkType(member.type, label)
    }
  }

  #checkType(type: ts.TypeNode, label: string): void {
    if (this.#checkedTypes.has(type)) return
    this.#checkedTypes.add(type)

    if (ts.isTypeLiteralNode(type)) {
      for (const member of type.members) {
        this.#checkMember(member, `${label}.${memberName(member)}`, type.members)
      }
      return
    }

    if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) {
      this.#checkTypeParameters(type, label)
      for (const parameter of type.parameters) {
        if (parameter.type !== undefined) this.#checkType(parameter.type, `${label} parameter`)
      }
      this.#checkType(type.type, `${label} result`)
      return
    }

    if (ts.isMappedTypeNode(type)) {
      if (type.typeParameter.constraint !== undefined) {
        this.#checkType(type.typeParameter.constraint, `${label} key`)
      }
      if (type.nameType !== undefined) this.#checkType(type.nameType, `${label} key`)
      if (type.type !== undefined) this.#checkType(type.type, `${label} value`)
      return
    }

    if (ts.isTypeReferenceNode(type)) {
      for (const typeArgument of type.typeArguments ?? []) {
        this.#checkType(typeArgument, label)
      }
      this.#checkReferencedNode(type.typeName, label)
      return
    }

    ts.forEachChild(type, child => {
      if (ts.isTypeNode(child)) this.#checkType(child, label)
    })
  }

  #checkTypeParameters(node: ts.Node, label: string): void {
    const typeParameters = (node as ts.Node & { readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> })
      .typeParameters

    for (const typeParameter of typeParameters ?? []) {
      if (typeParameter.constraint !== undefined) {
        this.#checkType(typeParameter.constraint, `${label} type parameter`)
      }
      if (typeParameter.default !== undefined) {
        this.#checkType(typeParameter.default, `${label} type parameter`)
      }
    }
  }

  #checkReferencedNode(node: ts.Node, label: string): void {
    const symbol = this.#typeChecker.getSymbolAtLocation(node)
    if (symbol === undefined) return

    const resolved = this.#resolveSymbol(symbol)
    const declarations = resolved.getDeclarations() ?? symbol.getDeclarations() ?? []

    for (const declaration of declarations) {
      if (!this.#isWorkspaceDeclaration(declaration) || !isAuditableTypeDeclaration(declaration)) continue
      this.#checkDeclaration(declaration, `${label} (${resolved.name})`, declarations)
    }
  }

  #resolveSymbol(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? this.#typeChecker.getAliasedSymbol(symbol) : symbol
  }

  #isWorkspaceDeclaration(declaration: ts.Declaration): boolean {
    const source = declaration.getSourceFile()
    const path = relative(this.#workspaceDirectory, source.fileName)

    if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return false
    return !path.split(sep).includes("node_modules")
  }

  #requireDocumentation(node: ts.Node, label: string): void {
    if (hasDocumentation(node)) return

    this.#issues.push({
      label: `${label} is missing documentation`,
      location: sourceLocation(node, this.#workspaceDirectory),
    })
  }
}

const packageDirectory = resolve(import.meta.dirname, "..")
const workspaceDirectory = resolve(packageDirectory, "..")
const configPath = resolve(packageDirectory, "tsconfig.build.json")
const publicEntrypoints = ["src/index.ts", "src/testing.ts", "src/jsx-runtime.ts", "src/jsx-dev-runtime.ts"] as const

/** Runs the repository's public SDK documentation gate. */
function runPublicApiDocumentationCheck(): void {
  const config = ts.readConfigFile(configPath, ts.sys.readFile)

  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDirectory, undefined, configPath)
  const program = ts.createProgram({ options: parsed.options, rootNames: parsed.fileNames })
  const checker = new PublicApiDocumentationChecker(program, workspaceDirectory)
  const issues = checker.check(publicEntrypoints.map(entrypoint => resolve(packageDirectory, entrypoint)))

  if (issues.length > 0) {
    const details = issues.map(issue => `- ${issue.location} ${issue.label}`).join("\n")
    throw new Error(
      `Public API declarations and their locally owned public shapes require adjacent JSDoc blocks:\n${details}`
    )
  }

  console.log("Public SDK declarations and locally owned nested shapes have JSDoc coverage")
}

function hasDocumentation(node: ts.Node): boolean {
  let current: ts.Node | undefined = node

  while (current !== undefined) {
    if (ts.getJSDocCommentsAndTags(current).some(comment => ts.isJSDoc(comment))) {
      return true
    }

    if (ts.isStatement(current) || ts.isClassElement(current) || ts.isTypeElement(current)) {
      return false
    }

    current = current.parent
  }

  return false
}

function isOverloadImplementation(declaration: ts.Declaration, siblings: readonly ts.Declaration[]): boolean {
  if (!hasBody(declaration)) return false

  return siblings.some(
    sibling =>
      sibling !== declaration &&
      sibling.kind === declaration.kind &&
      declarationName(sibling) === declarationName(declaration) &&
      !hasBody(sibling)
  )
}

function hasBody(declaration: ts.Declaration): boolean {
  return (
    (ts.isConstructorDeclaration(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    declaration.body !== undefined
  )
}

function isPublicMember(member: ts.ClassElement | ts.TypeElement): boolean {
  if (!ts.isClassElement(member)) return true
  if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) return false
  return (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) === 0
}

function isExported(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
  return modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
}

function isAuditableTypeDeclaration(declaration: ts.Declaration): boolean {
  return (
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isModuleDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration)
  )
}

function declarationName(declaration: ts.Declaration): string {
  if (ts.isConstructorDeclaration(declaration)) return "constructor"
  if (
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isModuleDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration)
  ) {
    if (declaration.name !== undefined) return declaration.name.getText()
  }
  return ts.SyntaxKind[declaration.kind]
}

function memberName(member: ts.ClassElement | ts.TypeElement): string {
  if (member.name !== undefined) return member.name.getText()
  return ts.SyntaxKind[member.kind]
}

function sourceLocation(node: ts.Node, workspaceDirectory: string): string {
  const source = node.getSourceFile()
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  return `${relative(workspaceDirectory, source.fileName)}:${line}`
}

if (import.meta.main) runPublicApiDocumentationCheck()
