/**
 * locator_find — search file bodies and DSH session messages.
 * @module dsh-locator/find
 */
import type { ContentIndex } from './content.ts';
/**
 * Content-index state shared by the `locator_find` and `locator_status` output
 * schemas. Keep it in sync with `ContentState`: the host validates every tool
 * result against the declared schema and rejects undeclared fields, so a state
 * field missing here makes the whole tool call fail as "invalid output".
 */
export declare const CONTENT_STATE_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly building: {
            readonly type: "boolean";
        };
        readonly files: {
            readonly type: "integer";
        };
        readonly sessions: {
            readonly type: "integer";
        };
        readonly messages: {
            readonly type: "integer";
        };
        readonly truncated: {
            readonly type: "boolean";
        };
        readonly updatedAt: {
            readonly type: "integer";
        };
        readonly error: {
            readonly type: "string";
        };
        readonly warnings: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Non-fatal build problems, e.g. an unreadable session log.";
        };
        readonly fullIndex: {
            readonly type: "boolean";
        };
        readonly reasoningIndex: {
            readonly type: "boolean";
        };
        readonly toolResultsIndex: {
            readonly type: "boolean";
        };
        readonly progress: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly phase: {
                    readonly type: "string";
                };
                readonly scanned: {
                    readonly type: "integer";
                };
                readonly indexed: {
                    readonly type: "integer";
                };
                readonly total: {
                    readonly type: "integer";
                };
                readonly path: {
                    readonly type: "string";
                };
                readonly startedAt: {
                    readonly type: "integer";
                };
            };
        };
    };
};
/** Build the locator_find tool. */
export declare function makeFindTool(content: ContentIndex, ensure?: () => void, roots?: readonly string[], allowCrossWorkspaceSessions?: boolean): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=find.d.ts.map