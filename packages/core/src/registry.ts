import { dirname } from "./path-utils.js";
import type {
  BridgeConversation,
  BridgeRegistry,
  FileSystemLike,
  RepairState,
  ToolName,
} from "./types.js";

export function emptyRegistry(): BridgeRegistry {
  return {
    version: 1,
    conversations: [],
  };
}

export function validateRegistryShape(value: unknown): BridgeRegistry {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid registry shape");
  }

  const candidate = value as Partial<BridgeRegistry>;
  if (candidate.version !== 1 || !Array.isArray(candidate.conversations)) {
    throw new Error("Invalid registry shape");
  }

  return candidate as BridgeRegistry;
}

export async function loadRegistry(
  registryPath: string,
  fs: Pick<FileSystemLike, "readFile">,
): Promise<BridgeRegistry> {
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    return validateRegistryShape(JSON.parse(raw));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return emptyRegistry();
    }
    throw error;
  }
}

export async function saveRegistry(
  registryPath: string,
  registry: BridgeRegistry,
  fs: Pick<FileSystemLike, "mkdir" | "writeFile" | "rename">,
): Promise<void> {
  const tempPath = `${registryPath}.tmp`;
  await fs.mkdir(dirname(registryPath), { recursive: true });
  await fs.writeFile(
    tempPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(tempPath, registryPath);
}

export function findConversationByProjectKey(
  registry: BridgeRegistry,
  projectKey: string,
): BridgeConversation | undefined {
  return registry.conversations.find(
    (conversation) => conversation.projectKey === projectKey,
  );
}

export function findConversationByBridgeSessionId(
  registry: BridgeRegistry,
  bridgeSessionId: string,
): BridgeConversation | undefined {
  return registry.conversations.find(
    (conversation) => conversation.bridgeSessionId === bridgeSessionId,
  );
}

export function findConversationByNativeSession(
  registry: BridgeRegistry,
  tool: ToolName,
  nativeId: string,
): BridgeConversation | undefined {
  return registry.conversations.find(
    (conversation) => conversation.mirrors[tool]?.nativeId === nativeId,
  );
}

export function upsertConversation(
  registry: BridgeRegistry,
  conversation: BridgeConversation,
): BridgeRegistry {
  const index = registry.conversations.findIndex(
    (existing) => existing.bridgeSessionId === conversation.bridgeSessionId,
  );

  if (index === -1) {
    return {
      ...registry,
      conversations: [...registry.conversations, conversation],
    };
  }

  const existing = registry.conversations[index];
  const merged: BridgeConversation = {
    ...existing,
    ...conversation,
    createdAt: existing.createdAt,
    mirrors: {
      ...existing.mirrors,
      ...conversation.mirrors,
    },
    repair: conversation.repair ?? existing.repair,
  };

  return {
    ...registry,
    conversations: registry.conversations.map((item, itemIndex) =>
      itemIndex === index ? merged : item,
    ),
  };
}

export function markConversationConflicted(
  conversation: BridgeConversation,
  reason: string,
  updatedAt: string,
): BridgeConversation {
  return {
    ...conversation,
    status: "conflicted",
    updatedAt,
    repair: {
      status: "needed",
      reason,
      updatedAt,
    },
  };
}

export function setRepairState(
  conversation: BridgeConversation,
  repair: RepairState,
): BridgeConversation {
  return {
    ...conversation,
    repair,
  };
}
