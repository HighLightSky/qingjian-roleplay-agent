package com.example.web.dto;

import java.util.List;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/** 图片字节仅在请求内存在；catalog 和 observations 是浏览器持有的来源记录。 */
public final class VisualDtos {
        private VisualDtos() {
        }

        @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
        @JsonSubTypes({
                @JsonSubTypes.Type(value = MessageSource.class, name = "message"),
                @JsonSubTypes.Type(value = CharacterPhotoSource.class, name = "character_photo"),
                @JsonSubTypes.Type(value = GenerationSource.class, name = "scene_generation")
        })
        public sealed interface Source permits MessageSource, CharacterPhotoSource, GenerationSource {
        }

        /** 聊天上传顺序独立于角色照片，序号从 1 开始。 */
        public record MessageSource(String messageId, int seq, String text, int imageIndex, int uploadIndex)
                        implements Source {
        }

        public record CharacterPhotoSource(String characterId, int profileVersion) implements Source {
        }

        public record GenerationSource(String generationId, String planId, String messageId, int seq,
                        String summary, boolean rejected) implements Source {
        }

        /** 有损视觉观察，不等于原图全部细节；assetId 为 imgN，版本由服务端基于旧观察推进。 */
        public record Observation(String assetId, String summary, List<String> visibleDetails,
                        List<String> extractedText, List<String> uncertainDetails, List<Source> sources,
                        int version) {
                public Observation {
                        visibleDetails = visibleDetails == null ? List.of() : List.copyOf(visibleDetails);
                        extractedText = extractedText == null ? List.of() : List.copyOf(extractedText);
                        uncertainDetails = uncertainDetails == null ? List.of() : List.copyOf(uncertainDetails);
                        sources = sources == null ? List.of() : List.copyOf(sources);
                }
        }

        public record Usage(String messageId, String purpose) {
        }

        public sealed interface ReferencedAsset permits Asset, MissingAsset {
                String assetId();
                List<Source> sources();
                Observation observation();
        }

        /** 只记录已丢失原件的真实引用，不伪造图片元信息。 */
        public record MissingAsset(String assetId, List<Source> sources, Observation observation)
                        implements ReferencedAsset {
                public MissingAsset {
                        sources = sources == null ? List.of() : List.copyOf(sources);
                }
        }

        /** assetId 使用浏览器全局递增的 imgN。仅限当前会话的图片目录，包含元信息、观察和使用来源，不含字节。 */
        public record Asset(String assetId, String sha256, String mimeType, long byteSize, int width, int height,
                        List<Source> sources, Observation observation, List<Usage> recentUses, String sourceSha256) implements ReferencedAsset {
                public Asset { sourceSha256 = sourceSha256 == null ? sha256 : sourceSha256; }
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
        public record Context(String sessionId, List<Asset> assetCatalog, Plan plan, List<Payload> imagePayloads,
                        List<MissingAsset> missingAssets) {
                public Context {
                        missingAssets = missingAssets == null ? List.of() : List.copyOf(missingAssets);
                        assetCatalog = assetCatalog == null ? List.of() : assetCatalog;
                        imagePayloads = imagePayloads == null ? List.of() : imagePayloads;
                }
        }

}
