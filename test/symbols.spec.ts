import { describe, expect, it } from 'vitest'
import { estimateSymbolTokens, extractSymbols, extractSymbolsForPath, languageForPath, SYMBOL_LANGUAGES, type CodeSymbol } from '../src/symbols.ts'

/** 1-based line of the first occurrence of an exact line. */
function lineOf(source: string, text: string): number {
  const index = source.split('\n').indexOf(text)
  if (index < 0) throw new Error('fixture line not found: ' + text)
  return index + 1
}

function find(symbols: readonly CodeSymbol[], name: string, kind?: string): CodeSymbol | undefined {
  return symbols.find(symbol => symbol.name === name && (kind === undefined || symbol.kind === kind))
}

describe('languageForPath', () => {
  it('maps supported source extensions to language ids', () => {
    expect(languageForPath('/tmp/main.go')).toBe('go')
    expect(languageForPath('/tmp/app.ts')).toBe('typescript')
    expect(languageForPath('/tmp/app.tsx')).toBe('typescript')
    expect(languageForPath('/tmp/app.mjs')).toBe('javascript')
    expect(languageForPath('/tmp/tool.py')).toBe('python')
    expect(languageForPath('/tmp/lib.rs')).toBe('rust')
    expect(languageForPath('/tmp/A.java')).toBe('java')
    expect(languageForPath('/tmp/a.c')).toBe('c')
    expect(languageForPath('/tmp/a.cpp')).toBe('cpp')
    expect(languageForPath('/tmp/a.cs')).toBe('csharp')
    expect(languageForPath('/tmp/a.php')).toBe('php')
    expect(languageForPath('/tmp/a.rb')).toBe('ruby')
    expect(languageForPath('/tmp/a.kt')).toBe('kotlin')
    expect(languageForPath('/tmp/a.swift')).toBe('swift')
    expect(languageForPath('/tmp/README.md')).toBe('markdown')
  })

  it('returns null for data files and unknown languages', () => {
    expect(languageForPath('/tmp/archive.zip')).toBeNull()
    expect(languageForPath('/tmp/Makefile')).toBeNull()
    expect(languageForPath('/tmp/data.json')).toBeNull()
  })

  it('advertises every parser language', () => {
    for (const language of ['go', 'typescript', 'javascript', 'python', 'rust', 'java', 'c', 'cpp', 'csharp', 'php', 'ruby', 'kotlin', 'swift', 'markdown']) {
      expect(SYMBOL_LANGUAGES).toContain(language)
    }
  })
})

describe('extractSymbols — Go', () => {
  const source = [
    'package demo',
    '',
    '// func notADeclaration() is only a comment',
    'type Server struct {',
    '\tName string',
    '}',
    '',
    'func (s *Server) Start(port int) error {',
    '\treturn nil',
    '}',
    '',
    'func NewServer() *Server {',
    '\treturn &Server{}',
    '}',
    '',
    'const MaxPort = 8080',
    'var Debug = false',
  ].join('\n')

  it('extracts structs, methods, functions and values with line numbers', () => {
    const symbols = extractSymbols(source, 'go')
    expect(symbols.map(symbol => symbol.name)).toEqual(['Server', 'Start', 'NewServer', 'MaxPort', 'Debug'])
    expect(find(symbols, 'Server')).toMatchObject({ kind: 'struct', line: lineOf(source, 'type Server struct {'), language: 'go' })
    expect(find(symbols, 'Start')).toMatchObject({ kind: 'method', line: lineOf(source, 'func (s *Server) Start(port int) error {'), scope: 'Server' })
    expect(find(symbols, 'NewServer')).toMatchObject({ kind: 'function', line: lineOf(source, 'func NewServer() *Server {') })
    expect(find(symbols, 'MaxPort')).toMatchObject({ kind: 'constant', line: lineOf(source, 'const MaxPort = 8080') })
    expect(find(symbols, 'Debug')).toMatchObject({ kind: 'variable' })
  })

  it('ignores declaration shapes inside comments', () => {
    expect(find(extractSymbols(source, 'go'), 'notADeclaration')).toBeUndefined()
  })
})

describe('extractSymbols — TypeScript', () => {
  const source = [
    'export interface Point { x: number; y: number }',
    '',
    'export class Shape {',
    '  constructor(private readonly origin: Point) {}',
    '',
    '  move(dx: number, dy: number): void {',
    '    const step = 2',
    '    if (dx > 0) { this.touch(dx) }',
    '  }',

    '  area(): number {',
    '    return 0',
    '  }',
    '}',

    'export function distance(a: Point, b: Point): number {',
    '  return 0',
    '}',

    'export const SCALE = 2',
    'export let counter = 0',
    'export const load = async () => 1',
    'export type Kind = true',
    'export enum Direction { North, South }',
    "const note = 'class Fake {'",
    '// function commentedOut() {}',
  ].join('\n')

  it('extracts types, classes, methods, functions and values', () => {
    const symbols = extractSymbols(source, 'typescript')
    expect(find(symbols, 'Point')).toMatchObject({ kind: 'interface', line: lineOf(source, 'export interface Point { x: number; y: number }') })
    expect(find(symbols, 'Shape')).toMatchObject({ kind: 'class', line: lineOf(source, 'export class Shape {') })
    expect(find(symbols, 'constructor')).toMatchObject({ kind: 'method', scope: 'Shape' })
    expect(find(symbols, 'move')).toMatchObject({ kind: 'method', scope: 'Shape' })
    expect(find(symbols, 'area')).toMatchObject({ kind: 'method', scope: 'Shape' })
    expect(find(symbols, 'distance')).toMatchObject({ kind: 'function' })
    expect(find(symbols, 'SCALE')).toMatchObject({ kind: 'constant' })
    expect(find(symbols, 'counter')).toMatchObject({ kind: 'variable' })
    expect(find(symbols, 'load')).toMatchObject({ kind: 'function' })
    expect(find(symbols, 'Kind')).toMatchObject({ kind: 'type' })
    expect(find(symbols, 'Direction')).toMatchObject({ kind: 'enum' })
  })

  it('does not report locals, control keywords, comments or strings', () => {
    const names = extractSymbols(source, 'typescript').map(symbol => symbol.name)
    expect(names).not.toContain('step')
    expect(names).not.toContain('if')
    expect(names).not.toContain('Fake')
    expect(names).not.toContain('commentedOut')
    expect(names).not.toContain('touch')
  })
})

describe('extractSymbols — Python', () => {
  const source = [
    'import os',
    '',
    'class Engine:',
    '    """A class docstring."""',
    '',
    '    def __init__(self, name):',
    '        self.name = name',

    '    def start(self):',
    '        return True',

    'def helper(value):',
    '    """def fake_in_docstring(): pass"""',
    '    return value',

    'MAX_RETRIES = 3',
    "lower_name = 'x'",
  ].join('\n')

  it('tracks class scope, methods, functions, constants and variables', () => {
    const symbols = extractSymbols(source, 'python')
    expect(find(symbols, 'Engine')).toMatchObject({ kind: 'class', line: lineOf(source, 'class Engine:') })
    expect(find(symbols, '__init__')).toMatchObject({ kind: 'method', scope: 'Engine' })
    expect(find(symbols, 'start')).toMatchObject({ kind: 'method', scope: 'Engine' })
    expect(find(symbols, 'helper')).toMatchObject({ kind: 'function' })
    expect(find(symbols, 'MAX_RETRIES')).toMatchObject({ kind: 'constant' })
    expect(find(symbols, 'lower_name')).toMatchObject({ kind: 'variable' })
  })

  it('ignores text inside docstrings', () => {
    expect(find(extractSymbols(source, 'python'), 'fake_in_docstring')).toBeUndefined()
  })
})

describe('extractSymbols — Markdown', () => {
  const source = [
    '# Title',
    '',
    'Some text with # not a heading',
    '',
    '## Section',
    '',
    '```js',
    '# Not a heading',
    '```',
    '',
    '### Deep',
  ].join('\n')

  it('extracts ATX headings with levels and skips fenced code', () => {
    const symbols = extractSymbols(source, 'markdown')
    expect(symbols.map(symbol => symbol.name)).toEqual(['Title', 'Section', 'Deep'])
    expect(symbols[0]).toMatchObject({ kind: 'heading', line: 1, scope: 'h1' })
    expect(symbols[1]).toMatchObject({ kind: 'heading', line: lineOf(source, '## Section'), scope: 'h2' })
    expect(symbols[2]).toMatchObject({ kind: 'heading', line: lineOf(source, '### Deep'), scope: 'h3' })
  })
})

describe('extractSymbols — other languages', () => {
  it('extracts Rust impl methods', () => {
    const source = [
      'pub struct Counter { value: u32 }',
      '',
      'impl Counter {',
      '    pub fn new() -> Self { Counter { value: 0 } }',
      '    pub fn bump(&mut self) { self.value += 1; }',
      '}',
      '',
      'pub fn helper() -> u32 { 1 }',
      'const LIMIT: u32 = 5;',
    ].join('\n')
    const symbols = extractSymbols(source, 'rust')
    expect(find(symbols, 'Counter', 'struct')).toMatchObject({ kind: 'struct' })
    expect(find(symbols, 'Counter', 'impl')).toMatchObject({ kind: 'impl' })
    expect(find(symbols, 'new')).toMatchObject({ kind: 'method', scope: 'Counter' })
    expect(find(symbols, 'bump')).toMatchObject({ kind: 'method', scope: 'Counter' })
    expect(find(symbols, 'helper')).toMatchObject({ kind: 'function' })
    expect(find(symbols, 'LIMIT')).toMatchObject({ kind: 'constant' })
  })

  it('extracts Java classes and methods', () => {
    const source = [
      'public class Greeter {',
      '    private final String name;',
      '    public Greeter(String name) { this.name = name; }',
      '    public String greet(int times) { return name; }',
      '}',
    ].join('\n')
    const symbols = extractSymbols(source, 'java')
    expect(find(symbols, 'Greeter', 'class')).toBeDefined()
    expect(find(symbols, 'greet')).toMatchObject({ kind: 'method', scope: 'Greeter' })
  })

  it('extracts C macros, structs and functions', () => {
    const source = [
      '#include <stdio.h>',
      '#define MAX_LEN 128',
      'struct Point { int x; int y; };',
      'static int add(int a, int b) {',
      '    return a + b;',
      '}',
    ].join('\n')
    const symbols = extractSymbols(source, 'c')
    expect(find(symbols, 'MAX_LEN')).toMatchObject({ kind: 'macro' })
    expect(find(symbols, 'Point')).toMatchObject({ kind: 'struct' })
    expect(find(symbols, 'add')).toMatchObject({ kind: 'function', line: lineOf(source, 'static int add(int a, int b) {') })
  })

  it('extracts C++ namespaces, classes and qualified methods', () => {
    const source = [
      'namespace geo {',
      'class Circle {',
      'public:',
      '    double area() const;',
      '};',
      'double Circle::area() const { return 3.14; }',
      '}',
    ].join('\n')
    const symbols = extractSymbols(source, 'cpp')
    expect(find(symbols, 'geo')).toMatchObject({ kind: 'namespace' })
    expect(find(symbols, 'Circle', 'class')).toMatchObject({ kind: 'class' })
    expect(symbols.some(symbol => symbol.name === 'area' && symbol.kind === 'method' && symbol.scope === 'Circle')).toBe(true)
  })

  it('extracts Ruby classes, methods and constants', () => {
    const source = [
      'class Widget',
      '  LIMIT = 10',
      '  def render',
      '    true',
      '  end',
      'end',
    ].join('\n')
    const symbols = extractSymbols(source, 'ruby')
    expect(find(symbols, 'Widget')).toMatchObject({ kind: 'class' })
    expect(find(symbols, 'render')).toMatchObject({ kind: 'method', scope: 'Widget' })
    expect(find(symbols, 'LIMIT')).toMatchObject({ kind: 'constant' })
  })
})

describe('extractSymbols extras', () => {
  it('returns an empty list for unknown languages and real empty input', () => {
    expect(extractSymbols('func main() {}', 'brainfuck')).toEqual([])
    expect(extractSymbols('', 'go')).toEqual([])
  })

  it('caps the number of symbols per file', () => {
    const source = Array.from({ length: 20 }, (_, index) => 'func fn' + String(index) + '() {}').join('\n')
    expect(extractSymbols(source, 'go', { maxSymbols: 5 })).toHaveLength(5)
  })

  it('extracts by path', () => {
    expect(extractSymbolsForPath('/tmp/main.go', 'func main() {}').map(symbol => symbol.name)).toEqual(['main'])
    expect(extractSymbolsForPath('/tmp/data.json', '{}')).toEqual([])
  })
})

describe('estimateSymbolTokens', () => {
  it('grows with symbol count and path length', () => {
    const one = estimateSymbolTokens('/tmp/a.ts', [{ name: 'a', kind: 'function', line: 1 }])
    const many = estimateSymbolTokens('/tmp/a.ts', [
      { name: 'a', kind: 'function', line: 1 },
      { name: 'b', kind: 'class', line: 2 },
      { name: 'c', kind: 'method', line: 3 },
    ])
    expect(one).toBeGreaterThanOrEqual(1)
    expect(many).toBeGreaterThan(one)
    expect(estimateSymbolTokens('/tmp/deep/path/a.ts', [])).toBeGreaterThan(estimateSymbolTokens('/a.ts', []))
  })
})