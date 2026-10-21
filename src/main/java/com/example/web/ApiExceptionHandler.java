package com.example.web;

import java.io.IOException;
import java.net.http.HttpTimeoutException;

import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import com.example.web.dto.ApiError;

/** 流式输出开始前的错误统一返回 JSON，不将上游错误正文或密钥发送给浏览器。 */
@RestControllerAdvice
public class ApiExceptionHandler {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(com.example.service.ContextTooLargeException.class)
    public ResponseEntity<ApiError> contextTooLarge(com.example.service.ContextTooLargeException exception) {
        return jsonError(HttpStatus.CONFLICT, new ApiError("CONTEXT_TOO_LARGE", exception.getMessage()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiError> badRequest(IllegalArgumentException exception) {
        return jsonError(HttpStatus.BAD_REQUEST, new ApiError("BAD_REQUEST", exception.getMessage()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> invalidJson(HttpMessageNotReadableException exception) {
        // RequestSizeFilter 在分块读取超限时中断输入流，这里把它恢复成 413。
        if (exception.getMostSpecificCause() instanceof IOException cause
                && RequestSizeFilter.REQUEST_TOO_LARGE.equals(cause.getMessage())) {
            return jsonError(HttpStatus.PAYLOAD_TOO_LARGE,
                    new ApiError("REQUEST_TOO_LARGE", "请求体不能超过 64 MiB。"));
        }
        return jsonError(HttpStatus.BAD_REQUEST,
                new ApiError("BAD_REQUEST", "请求正文缺失或 JSON 格式错误。"));
    }

    @ExceptionHandler({IOException.class, InterruptedException.class, RuntimeException.class})
    public ResponseEntity<ApiError> modelError(Exception exception, HttpServletResponse response) {
        log.error("模型处理失败：{}", exception.getMessage(), exception);
        // 已提交的 SSE 响应或已断开的连接不能再改成 JSON 响应。
        if (response.isCommitted()) {
            return null;
        }
        HttpStatus status = exception instanceof HttpTimeoutException
                ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.BAD_GATEWAY;
        return jsonError(status, toModelError(exception));
    }

    /** 普通 JSON 错误和 SSE error 事件使用同样的错误码与文案。 */
    static ApiError toModelError(Exception exception) {
        if (exception instanceof com.example.service.ContextTooLargeException)
            return new ApiError("CONTEXT_TOO_LARGE", exception.getMessage());
        return exception instanceof HttpTimeoutException
                ? new ApiError("MODEL_TIMEOUT", "模型请求超时，请稍后重试。")
                : new ApiError("MODEL_ERROR", "模型服务调用失败，请稍后重试。");
    }

    private ResponseEntity<ApiError> jsonError(HttpStatus status, ApiError error) {
        // 显式设置 JSON，确保请求 Accept 为 text/event-stream 时仍能返回 JSON 错误。
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .cacheControl(CacheControl.noStore())
                .body(error);
    }
}
