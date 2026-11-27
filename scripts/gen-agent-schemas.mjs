#!/usr/bin/env node
/**
 * gen-agent-schemas.mjs — standard JSON Schema generator/checker for the
 * versioned (agent API 2026-11) MCP/CLI tool surface.
 *
 * The host tools declare their schemas in the dsh-tools DSL, which marks
 * required object properties with `required: true` inside the property schema.
 * That is NOT valid JSON Schema and DSH (as an MCP client) rejects an
 * outputSchema/inputSchema with MCP_INVALID_RESULT. This script materializes
 * the standard JSON Schema published by scripts/locator-mcp.mjs (generated from
 * the same DSL by scripts/locator-cli.mjs) and checks that:
 *   1. no host-DSL-only annotation leaks into the generated schemas;
 *   2. the apiVersion and the closed 12-code error set stay in sync with
 *      src/agent-core.ts whenever the source tree is present.
 *
 * Usage:
 *   node scripts/gen-agent-schemas.mjs           # print the generated schemas
 *   node scripts/gen-agent-schemas.mjs --check   # validate/sync check (CI gate)
 * @module scripts/gen-agent-schemas
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AGENT_API_VERSION,
  AGENT_ERROR_CODE_LIST,
  AGENT_SCHEMA_DSL,
  buildAgentToolSchemas,
  hostDslToJsonSchema,
} from './locator-cli.mjs'

/** Package root (this script lives in <root>/scripts/). */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Build the generated standard JSON Schema of every surface. */
export function buildSchemas() {
  return buildAgentToolSchemas()
}

/**
 * Collect every host-DSL-only artifact left in a JSON Schema tree.
 * @param node - schema value.
 * @param path - JSON path used in diagnostics.
 * @returns list of human-readable violations.
 */
export function standardJsonSchemaViolations(node, path = '$') {
  const problems = []
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) problems.push(...standardJsonSchemaViolations(item, path + '[' + String(index) + ']'))
    return problems
  }
  if (node === null || typeof node !== 'object') return problems
  if (node.type === 'json') problems.push(path + ': host-DSL type "json" leaked into JSON Schema')
  if (node.required === true) problems.push(path + ': host-DSL property-level required:true leaked into JSON Schema')
  if (node.properties !== undefined) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      problems.push(path + '.properties: must be an object')
    } else {
      for (const [name, property] of Object.entries(node.properties)) {
        if (property !== null && typeof property === 'object' && property.required === true) {
          problems.push(path + '.properties.' + name + ': property-level required:true is not JSON Schema; list it in the object required array')
        }
        problems.push(...standardJsonSchemaViolations(property, path + '.properties.' + name))
      }
    }
  }
  for (const key of ['items', 'additionalProperties', 'propertyNames']) {
    if (node[key] !== undefined) problems.push(...standardJsonSchemaViolations(node[key], path + '.' + key))
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[key])) {
      for (const [index, item] of node[key].entries()) problems.push(...standardJsonSchemaViolations(item, path + '.' + key + '[' + String(index) + ']'))
    }
  }
  return problems
}

/**
 * Read the host contract from src/agent-core.ts (source of truth).
 * @returns { apiVersion?, codes?, problems } — problems lists missing files or unparsable input.
 */
export function readHostContract(root = packageRoot) {
  const file = join(root, 'src', 'agent-core.ts')
  if (!existsSync(file)) return { problems: ['src/agent-core.ts not found; skipped host contract sync check'] }
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    return { problems: ['cannot read src/agent-core.ts: ' + String(error && error.message ? error.message : error)] }
  }
  const versionMatch = /export const AGENT_API_VERSION\s*=\s*'([^']+)'/.exec(source)
  const codesMatch = /export const AGENT_ERROR_CODES\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(source)
  const codes = codesMatch === null
    ? undefined
    : [...codesMatch[1].matchAll(/'([a-z][a-z-]+)'/g)].map(match => match[1])
  return {
    apiVersion: versionMatch === null ? undefined : versionMatch[1],
    codes: codes === undefined ? undefined : [...new Set(codes)].sort(),
    problems: [],
  }
}

/**
 * Verify the generated schemas are standard JSON Schema and stay in sync with
 * the host contract.
 * @returns { ok, problems, schemas }
 */
export function checkSchemas(root = packageRoot) {
  const problems = []
  const schemas = buildSchemas()
  const toolSchemas = [
    ['find.input', schemas.find.input],
    ['find.output', schemas.find.output],
    ['read.input', schemas.read.input],
    ['read.output', schemas.read.output],
    ['status.input', schemas.status.input],
    ['status.output', schemas.status.output],
    ['failure', schemas.failure],
  ]
  for (const [name, schema] of toolSchemas) {
    if (schema.type !== 'object') problems.push(name + ': expected a top-level object schema')
    for (const violation of standardJsonSchemaViolations(schema, '$.' + name)) problems.push(violation)
  }
  if (schemas.find.output.additionalProperties !== false) problems.push('find.output must keep additionalProperties:false')
  if (schemas.find.output.required.includes('apiVersion') !== true) problems.push('find.output must require apiVersion')
  if (schemas.find.output.required.includes('ok') !== true) problems.push('find.output must require ok')
  if (schemas.find.output.required.includes('tool') !== true) problems.push('find.output must require tool')
  if (schemas.failure.properties.error === undefined) problems.push('failure schema lost its error block')
  if (AGENT_ERROR_CODE_LIST.length !== 12) problems.push('the closed error-code set must have exactly 12 codes (got ' + String(AGENT_ERROR_CODE_LIST.length) + ')')
  const host = readHostContract(root)
  for (const problem of host.problems) problems.push(problem)
  if (host.apiVersion !== undefined && host.apiVersion !== AGENT_API_VERSION) {
    problems.push('agent API version drift: host src/agent-core.ts says ' + host.apiVersion + ', generated surface says ' + AGENT_API_VERSION)
  }
  if (host.codes !== undefined) {
    const generated = [...AGENT_ERROR_CODE_LIST].sort()
    if (JSON.stringify(host.codes) !== JSON.stringify(generated)) {
      problems.push('error-code drift: host=' + JSON.stringify(host.codes) + ' generated=' + JSON.stringify(generated))
    }
  }
  // Round-trip check: the DSL must convert into the same materialized schemas.
  const inputSchemaOf = parameters => hostDslToJsonSchema({ type: 'object', additionalProperties: false, properties: parameters })
  const roundTrip = [
    ['find.input', inputSchemaOf(AGENT_SCHEMA_DSL.find.input), schemas.find.input],
    ['find.output', AGENT_SCHEMA_DSL.find.output, schemas.find.output],
    ['read.input', inputSchemaOf(AGENT_SCHEMA_DSL.read.input), schemas.read.input],
    ['read.output', AGENT_SCHEMA_DSL.read.output, schemas.read.output],
    ['status.input', inputSchemaOf(AGENT_SCHEMA_DSL.status.input), schemas.status.input],
    ['status.output', AGENT_SCHEMA_DSL.status.output, schemas.status.output],
    ['failure', AGENT_SCHEMA_DSL.failure, schemas.failure],
  ]
  for (const [name, dsl, materialized] of roundTrip) {
    if (JSON.stringify(hostDslToJsonSchema(dsl)) !== JSON.stringify(materialized)) problems.push(name + ': generation is not deterministic')
  }
  return { ok: problems.length === 0, problems, schemas }
}

/** Print usage text. */
function usage() {
  return [
    'gen-agent-schemas — standard JSON Schema generator/checker for dsh-locator agent API ' + AGENT_API_VERSION,
    '',
    'Usage:',
    '  node scripts/gen-agent-schemas.mjs           print the generated JSON Schema',
    '  node scripts/gen-agent-schemas.mjs --check   validate + host contract sync (CI gate)',
    '  node scripts/gen-agent-schemas.mjs --help',
  ].join('\n')
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage() + '\n')
    process.exitCode = 0
  } else if (argv.includes('--check')) {
    const result = checkSchemas()
    if (result.ok) {
      process.stdout.write('gen-agent-schemas: ok — standard JSON Schema, ' + String(AGENT_ERROR_CODE_LIST.length) + ' closed codes, host contract in sync\n')
      process.exitCode = 0
    } else {
      process.stderr.write('gen-agent-schemas: ' + String(result.problems.length) + ' problem(s):\n' + result.problems.map(problem => '  - ' + problem).join('\n') + '\n')
      process.exitCode = 1
    }
  } else {
    process.stdout.write(JSON.stringify(buildSchemas(), null, 2) + '\n')
    process.exitCode = 0
  }
}