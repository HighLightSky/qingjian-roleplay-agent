package com.example.web.dto;

/**
 * 返回给前端的错误信息，用于普通 JSON 响应或 SSE error 事件。
 *
 * @param code 错误码：BAD_REQUEST、MODEL_ERROR 或 MODEL_TIMEOUT
 * @param message 面向用户的错误说明，不应包含模型密钥等内部信息
 */
public record ApiError(
        String code,
        String message
) {}
