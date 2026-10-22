import type { Snapshot } from "../lib/backup";
import { DEFAULT_INTERACTION_SETTINGS } from "../lib/domain";
import { EMPTY_STORY } from "../lib/state/types";
import { unknownUsage } from "../lib/context/types";
import { sha256 } from "../lib/images/hash";
import type { Observation, VisualSource } from "../lib/images/types";

export const oldPhoto = "00000000-0000-4000-8000-000000000001";
export const oldUpload = "00000000-0000-4000-8000-000000000002";
export const timestamp = "2026-10-21T00:00:00Z";

export function legacyImageSnapshot(): Snapshot {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=",
    "base64",
  );
  const assets = [oldUpload, oldPhoto].map((id, index) => {
    const bytes = Buffer.concat([png, Buffer.from([index])]);
    return {
      id,
      sha256: sha256(bytes),
      mimeType: "image/png",
      byteSize: bytes.length,
      width: 1,
      height: 1,
      displayName: `${id}.png`,
      base64: bytes.toString("base64"),
      createdAt: timestamp,
    };
  });
  const profile = {
    name: "林溪",
    identity: "旧友",
    description: `文字设定包含 ${oldPhoto}`,
    appearancePhotoAssetId: oldPhoto,
  };
  const userText = `参考图 ${oldPhoto}`;
  const photoSource: VisualSource = {
    type: "character_photo",
    characterId: "character",
    profileVersion: 2,
  };
  const uploadSource: VisualSource = {
    type: "message",
    messageId: "u1",
    seq: 1,
    text: userText,
    imageIndex: 1,
    uploadIndex: 1,
  };
  const sources = [photoSource, uploadSource];
  const observation: Observation = {
    assetId: oldPhoto,
    summary: "红斗篷",
    visibleDetails: ["黑发"],
    extractedText: [oldPhoto],
    uncertainDetails: ["耳环模糊"],
    sources,
    version: 3,
  };
  const photo = assets.find((a) => a.id === oldPhoto)!;
  const catalog = [
    {
      assetId: photo.id,
      sha256: photo.sha256,
      mimeType: photo.mimeType,
      byteSize: photo.byteSize,
      width: 1,
      height: 1,
      sources,
      observation,
      recentUses: [{ messageId: "a2", purpose: "参考" }],
    },
  ];
  const summary = {
    text: `图片${oldPhoto}：红斗篷；${oldUpload}：新图。`,
    throughSeq: 2,
    version: 1,
  };
  const state = {
    sessionId: "session",
    characterId: "character",
    sessionVersion: 4,
    memoryVersion: 2,
    processedThroughSeq: 2,
    story: EMPTY_STORY,
    storySources: {},
    memories: [],
    goals: [],
  };
  const plan = {
    status: "ready" as const,
    selectedHistoricalImages: [{ assetId: oldPhoto, purpose: "核对耳环" }],
    candidateAssetIds: [],
    message: "",
    contextFingerprint: "historical-plan-fingerprint",
    operationId: "selection",
  };
  const context = {
    character: { ...profile, profileVersion: 2 },
    state,
    summary,
    history: [],
    input: {
      text: "新图",
      parts: [
        { type: "text" as const, text: "新图" },
        { type: "image" as const, assetId: oldUpload },
      ],
    },
    interactionSettings: DEFAULT_INTERACTION_SETTINGS,
    operationId: "state:a4",
    visual: {
      sessionId: "session",
      assetCatalog: catalog,
      plan,
      imagePayloads: [],
    },
  };
  const base = {
    sessionId: "session",
    status: "complete" as const,
    checkpointVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const messages = [
    {
      ...base,
      id: "u1",
      seq: 1,
      role: "user" as const,
      text: userText,
      parts: [
        { type: "text" as const, text: userText },
        { type: "image" as const, assetId: oldPhoto },
      ],
    },
    {
      ...base,
      id: "a2",
      seq: 2,
      role: "assistant" as const,
      replyToMessageId: "u1",
      segments: [{ kind: "narration" as const, text: "她查看地图。" }],
      usage: unknownUsage(),
    },
    {
      ...base,
      id: "u3",
      seq: 3,
      role: "user" as const,
      text: "新图",
      parts: context.input.parts,
    },
    {
      ...base,
      id: "a4",
      seq: 4,
      role: "assistant" as const,
      replyToMessageId: "u3",
      segments: [{ kind: "narration" as const, text: "她检查新图。" }],
      usage: unknownUsage(),
    },
  ];
  const sourceVersions = [
    { id: "u3", checkpointVersion: 1 },
    { id: "a4", checkpointVersion: 1 },
  ];
  const operationBase = {
    sessionId: "session",
    runId: "a4",
    anchorMessageId: "a4",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const data: Snapshot = {
    assets,
    characters: [
      {
        ...profile,
        id: "character",
        archived: false,
        profileVersion: 2,
        memoryVersion: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    sessions: [
      {
        id: "session",
        characterId: "character",
        title: "旧对话",
        titleSource: "manual",
        characterSnapshot: profile,
        profileVersion: 2,
        story: EMPTY_STORY,
        storySources: {},
        stateVersion: 4,
        stateProcessedThroughSeq: 2,
        summary,
        nextMessageSeq: 5,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    messages,
    memories: [],
    goals: [],
    drafts: [
      {
        sessionId: "session",
        text: "草稿",
        parts: [{ type: "image", assetId: oldUpload }],
        updatedAt: timestamp,
      },
    ],
    settings: [
      {
        key: "characterDraft:new",
        value: JSON.stringify({
          ...profile,
          appearancePhotoAssetId: oldUpload,
        }),
      },
    ],
    visualObservations: [
      {
        ...observation,
        id: `session:${oldPhoto}`,
        sessionId: "session",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    imageUsages: [
      {
        id: `a2:${oldPhoto}`,
        assetId: oldPhoto,
        sessionId: "session",
        messageId: "a2",
        purpose: "参考",
        createdAt: timestamp,
      },
    ],
    stateTasks: [
      {
        id: "state:a4",
        sessionId: "session",
        assistantMessageId: "a4",
        throughSeq: 4,
        context,
        automaticAttempts: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    compactionTasks: [
      {
        id: "compact",
        sessionId: "session",
        assistantMessageId: "a4",
        context: {
          ...context,
          operationId: "compact",
          history: [
            {
              id: "u3",
              role: "user",
              text: "新图",
              seq: 3,
              status: "complete",
              checkpointVersion: 1,
              parts: context.input.parts,
            },
          ],
        },
        automaticAttempts: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    operations: [
      {
        ...operationBase,
        id: "selection",
        kind: "selection",
        placement: "before",
        status: "committed",
        result: { plan, catalog },
      },
      {
        ...operationBase,
        id: "state:a4",
        kind: "state_update",
        placement: "after",
        status: "computed",
        sourceVersions,
        result: {
          operationId: "state:a4",
          sessionVersion: 4,
          memoryVersion: 2,
          fromExclusiveSeq: 2,
          throughSeq: 4,
          visualObservations: [
            { ...observation, version: 4 },
            {
              assetId: oldUpload,
              summary: "新地图",
              visibleDetails: [],
              extractedText: [],
              uncertainDetails: [],
              version: 1,
              sources: [
                {
                  type: "message",
                  messageId: "u3",
                  seq: 3,
                  text: "新图",
                  imageIndex: 1,
                  uploadIndex: 2,
                },
              ],
            },
          ],
          storyChanges: [],
          memoryChanges: [],
          goalChanges: [],
        },
      },
      {
        ...operationBase,
        id: "compact",
        kind: "compaction",
        placement: "before",
        status: "computed",
        sourceVersions,
        result: {
          operationId: "compact",
          sessionId: "session",
          baseSessionVersion: 4,
          baseMemoryVersion: 2,
          baseSummaryVersion: 1,
          fromExclusiveSeq: 2,
          throughSeq: 4,
          summary: {
            text: `图 ${oldPhoto} 与 ${oldUpload} 的线索。`,
            throughSeq: 4,
            version: 2,
          },
          beforeTokens: 1000,
          afterTokens: 100,
          sourceMessageIds: ["u3", "a4"],
          sourceFingerprint: "historical-source-fingerprint",
        },
      },
    ],
  };
  // 模拟 IndexedDB 各记录和 JSON 文件的独立对象，不共享可变引用。
  return JSON.parse(JSON.stringify(data)) as Snapshot;
}
