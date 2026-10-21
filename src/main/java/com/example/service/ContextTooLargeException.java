package com.example.service;

public class ContextTooLargeException extends IllegalArgumentException {
    public ContextTooLargeException(String message) { super(message); }
}
