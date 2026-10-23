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
  editing: () => { userMessageId?: string; submitting: boolean } = () => ({
    submitting: false,
  }),
): AttachmentAdapter {
  const assets = new Map<string, string>();
  const removed = new Set<string>();
  const owners = new Map<string, string | undefined>();
  let preparation: Promise<unknown> = Promise.resolve();
  return {
    accept: "image/jpeg,image/png",
    async *add({ file }) {
      const attachmentId = id();
      const owner = editing().userMessageId;
      owners.set(attachmentId, owner);
      // 先占用顺序，再异步读取文件，避免解码速度改变附件顺序。
      const ready = preparation.then(() =>
        prepareImage(file, sessionId, write, owner),
      );
      preparation = ready.catch(() => {});
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
      const asset = await ready;
      assets.set(attachmentId, asset.id);
      if (removed.has(attachmentId)) {
        await write(() => removeDraftImage(sessionId, asset.id, owner));
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
      const current = editing();
      const owner = owners.get(attachment.id);
      // 编辑发送会立即关闭内联输入框；引用由重发事务转交，不能按取消清理。
      if (owner && current.submitting) return;
      removed.add(attachment.id);
      const assetId =
        attachmentAssetId(attachment) ?? assets.get(attachment.id);
      if (assetId)
        await write(() => removeDraftImage(sessionId, assetId, owner));
    },
  };
}
