export type ToolName = "pi" | "claude" | "codex";

export type ConversationStatus = "active" | "archived" | "conflicted";

export interface SyncWatermark {
  sourceTool: ToolName;
  sourceSessionId: string;
  sourceOffset: number;
  targetTool: ToolName;
  targetSessionId: string;
  targetOffset: number;
  contentHash: string;
}

export interface ToolMirror {
  sessionPath: string;
  nativeId: string;
  seededSourceOffset?: number;
}

export interface RepairState {
  status: "idle" | "needed" | "running" | "failed";
  reason?: string;
  updatedAt?: string;
}

export interface BridgeConversation {
  bridgeSessionId: string;
  projectKey: string;
  canonicalCwd: string;
  createdAt: string;
  updatedAt: string;
  status: ConversationStatus;
  mirrors: Partial<Record<ToolName, ToolMirror>>;
  lastOriginTool?: ToolName;
  lastWrittenOffsets: SyncWatermark[];
  repair?: RepairState;
}

export interface BridgeRegistry {
  version: 1;
  conversations: BridgeConversation[];
}

export interface FileSystemLike {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(
    path: string,
    data: string,
    encoding: BufferEncoding,
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
}

export interface PathAccessLike {
  exists(path: string): Promise<boolean>;
}

export interface RepoDetector {
  findRepoRoot(cwd: string): Promise<string | null>;
}

export interface PiSessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface PiSessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: Record<string, unknown>;
  customType?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface PiSession {
  header: PiSessionHeader;
  entries: PiSessionEntry[];
}

export interface ClaudeCodeLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexRolloutItem {
  type: string;
  payload: Record<string, unknown>;
}

export type NormalizedContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType?: string; data: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName?: string;
      isError?: boolean;
      output: string;
    };

export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  timestamp: string;
  content: NormalizedContent[];
  model?: string;
  provider?: string;
  stopReason?: string | null;
  usage?: Record<string, unknown>;
}
