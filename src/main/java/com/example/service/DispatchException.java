package com.example.service;

import org.springframework.http.HttpStatus;

public class DispatchException extends RuntimeException {
    private final String code;
    private final HttpStatus status;

    public DispatchException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public String code() {
        return code;
    }

    public HttpStatus status() {
        return status;
    }
}
