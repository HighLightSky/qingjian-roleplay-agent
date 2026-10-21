package com.example.llm.model;

import java.util.List;

/** 模型内容使用明确的文本/图片块，纯文字仍序列化为字符串。 */
public class Message {
    public record Part(String type, String text, String imageUrl) {
        public static Part text(String value) {
            return new Part("text", value, null);
        }
        public static Part image(String value) {
            return new Part("image_url", null, value);
        }
    }
    private String role;
    private String content;
    private List<Part> parts;
    public Message(String role, String content) {
        this.role = role;
        this.content = content;
    }
    public Message(String role, List<Part> parts) {
        this.role = role;
        this.parts = parts;
    }
    public String getRole() {
        return role;
    }
    public void setRole(String role) {
        this.role = role;
    }
    public String getContent() {
        return content;
    }
    public void setContent(String content) {
        this.content = content;
    }
    public List<Part> getParts() {
        return parts;
    }
}
