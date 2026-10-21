package com.example.web.dto;

import java.util.List;

/** 图片字节仅在请求内存在；catalog 和 observations 是浏览器持有的来源记录。 */
public final class VisualDtos {
        private VisualDtos() {
        }

        /** 图片首次或再次上传的消息位置，imageIndex 从 1 开始。 */
        public record Source(String messageId, int seq, String text, int imageIndex, int uploadIndex) {
        }

        /** 有损视觉观察，不等于原图全部细节；版本由服务端基于旧观察推进。 */
        public record Observation(String assetId, String summary, List<String> visibleDetails,
                        List<String> extractedText, List<String> uncertainDetails, List<String> sourceMessageIds,
                        int version) {
                public Observation {
                        visibleDetails = visibleDetails == null ? List.of() : List.copyOf(visibleDetails);
                        extractedText = extractedText == null ? List.of() : List.copyOf(extractedText);
                        uncertainDetails = uncertainDetails == null ? List.of() : List.copyOf(uncertainDetails);
                        sourceMessageIds = sourceMessageIds == null ? List.of() : List.copyOf(sourceMessageIds);
                }
        }

        public record Usage(String messageId, String purpose) {
        }

        /** 仅限当前会话的图片目录，包含元信息、观察和使用来源，不含字节。 */
        public record Asset(String assetId, String sha256, String mimeType, long byteSize, int width, int height,
                        List<Source> sources, Observation observation, List<Usage> recentUses) {
        }

        /** 当前请求临时携带的原图，不在服务器持久化。 */
        public record Payload(String assetId, String sha256, String dataUrl) {
        }

        /** 选图模型选择的历史图片及本次用途。 */
        public record Selected(String assetId, String purpose) {
        }

        /** 绑定发送前快照的选图结果；歧义或超限时禁止进入正文生成。 */
        public record Plan(String status, List<Selected> selectedHistoricalImages, List<String> candidateAssetIds,
                        String message, String contextFingerprint, String operationId) {
        }

        /** 浏览器负责持有资产，后端从请求接收完整计算材料；缺省集合在此统一归一化。 */
        public record Context(String sessionId, List<Asset> assetCatalog, Plan plan, List<Payload> imagePayloads) {
                public Context {
                        assetCatalog = assetCatalog == null ? List.of() : assetCatalog;
                        imagePayloads = imagePayloads == null ? List.of() : imagePayloads;
                }
        }

}
