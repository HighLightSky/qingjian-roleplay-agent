package com.example.web.dto;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** 所有会话共用的交互偏好，由浏览器保存并随每次聊天请求提交。 */
public record InteractionSettingsDto(ReplyLength replyLength, NarrativeMode narrativeMode) {
    public enum ReplyLength {
        SHORT("short"), STANDARD("standard"), DETAILED("detailed");

        private final String value;

        ReplyLength(String value) {
            this.value = value;
        }

        @JsonValue
        public String value() {
            return value;
        }

        @JsonCreator
        public static ReplyLength fromValue(String value) {
            for (ReplyLength length : values()) {
                if (length.value.equals(value)) return length;
            }
            throw new IllegalArgumentException("回复长度只能是 short、standard 或 detailed");
        }
    }

    public enum NarrativeMode {
        INTERACTIVE("interactive"), SCENE("scene");

        private final String value;

        NarrativeMode(String value) {
            this.value = value;
        }

        @JsonValue
        public String value() {
            return value;
        }

        @JsonCreator
        public static NarrativeMode fromValue(String value) {
            for (NarrativeMode mode : values()) {
                if (mode.value.equals(value)) return mode;
            }
            throw new IllegalArgumentException("叙事推进只能是 interactive 或 scene");
        }
    }
}
