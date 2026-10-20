package com.example.web.dto;

/**
 * 当前会话的角色快照，由前端随请求传入，后端不保存。
 *
 * @param name 角色名称
 * @param description 角色的身份与背景
 * @param personality 性格特点
 * @param speakingStyle 说话风格
 * @param worldSetting 故事所在的世界观与环境设定
 * @param openingScene 开场场景，前端创建会话时也会将其写入首条角色消息
 */
public record CharacterDto(
        String name,
        String description,
        String personality,
        String speakingStyle,
        String worldSetting,
        String openingScene
) {}
