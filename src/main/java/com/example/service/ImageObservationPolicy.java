package com.example.service;

import java.util.Collection;
import java.util.List;
import com.example.web.dto.ChatApiRequest;

/** 已有观察及生成要求摘要不再成为整理器的看图任务。 */
public final class ImageObservationPolicy {
    private ImageObservationPolicy() {
    }

    public static List<String> observationAssetIds(ChatApiRequest context, Collection<String> usedAssetIds) {
        return usedAssetIds
                .stream().filter(id -> ImageValidationService.catalog(context).stream()
                        .filter(a -> a.assetId().equals(id)).noneMatch(a -> a.observation() != null || a.sources()
                                .stream().anyMatch(s -> s instanceof com.example.web.dto.VisualDtos.GenerationSource)))
                .toList();
    }
}
