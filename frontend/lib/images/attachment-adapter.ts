import type { AttachmentAdapter, Attachment } from "@assistant-ui/react";
import { id } from "../domain";
import { prepareImage, removeDraftImage } from "./repository";

export function attachmentAssetId(
  attachment: Pick<Attachment, "content">,
): string | undefined {
  const image = attachment.content?.find((p) => p.type === "image");
  return image?.type === "image" && image.image.startsWith("asset:")
    ? image.image.slice(6)
    : undefined;
}
export function createImageAttachmentAdapter(
  sessionId: string,
  write: <T>(task: () => Promise<T>) => Promise<T>,
): AttachmentAdapter {
  const assets = new Map<string, string>();
  const removed = new Set<string>();
  return {
    accept: "image/jpeg,image/png",
    async *add({ file }) {
      const attachmentId = id();
      const base = {
        id: attachmentId,
        type: "image",
        name: file.name,
        contentType: file.type,
        file,
      };
      yield {
        ...base,
        status: { type: "running", reason: "uploading", progress: 0 },
      };
      const asset = await prepareImage(file, sessionId, write);
      assets.set(attachmentId, asset.id);
      if (removed.has(attachmentId)) {
        await write(() => removeDraftImage(sessionId, asset.id));
        return;
      }
      yield {
        ...base,
        content: [{ type: "image", image: `asset:${asset.id}` }],
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async send(attachment, options) {
      options?.signal?.throwIfAborted();
      if (!attachmentAssetId(attachment)) throw new Error("图片尚未准备完成。");
      return {
        ...attachment,
        content: attachment.content!,
        status: { type: "complete" },
      };
    },
    async remove(attachment) {
      removed.add(attachment.id);
      const assetId =
        attachmentAssetId(attachment) ?? assets.get(attachment.id);
      if (assetId) await write(() => removeDraftImage(sessionId, assetId));
    },
  };
}
