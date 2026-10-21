package com.example.web.dto;

import java.util.List;

/** id 用于核验图片来源，parts 保留图文顺序，所有消息均携带稳定 ID。 */
public record HistoryMessageDto(String role, String text, String id, List<ContentPartDto> parts,
        int seq, String status, int checkpointVersion) {
}
