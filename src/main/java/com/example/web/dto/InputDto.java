package com.example.web.dto;

/**
 * 用户本轮输入，支持纯文字、纯图片或图文组合。
 *
 * @param text 本轮文字，可为 null 或空字符串；文字上限为 2000 字符
 * @param image 本轮附带的单张图片，无图片时为 null；不能与文字同时为空
 */
public record InputDto(
        String text,
        ImageDto image
) {}
