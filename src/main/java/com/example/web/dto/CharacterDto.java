package com.example.web.dto;

/** 当前会话创建时的角色快照；身份与自由描述可为空字符串，后端不保存。 */
public record CharacterDto(String name, String identity, String description) {
    public static final int MAX_NAME_CHARS = 60;
    public static final int MAX_IDENTITY_CHARS = 2000;
    public static final int MAX_DESCRIPTION_CHARS = 8000;

    /** 聊天、选图和视觉整理入口共用同一份角色约束。 */
    public static void validate(CharacterDto character) {
        if (character == null) {
            throw new IllegalArgumentException("角色快照不能为空");
        }
        validateField(character.name(), "角色名称", MAX_NAME_CHARS);
        if (character.name().isBlank()) {
            throw new IllegalArgumentException("角色名称不能为空");
        }
        validateField(character.identity(), "角色身份", MAX_IDENTITY_CHARS);
        validateField(character.description(), "角色描述", MAX_DESCRIPTION_CHARS);
    }

    private static void validateField(String value, String label, int maxChars) {
        if (value == null) {
            throw new IllegalArgumentException(label + "必须提供，无内容时请传空字符串");
        }
        if (value.length() > maxChars) {
            throw new IllegalArgumentException(label + "不能超过 " + maxChars + " 字符");
        }
    }
}
