package com.example;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.ArrayList;
import java.util.List;

import com.example.llm.OpenAiClient;
import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatResponse;
import com.example.llm.model.Message;
import com.fasterxml.jackson.databind.ObjectMapper;


public class App 
{
    public static void main( String[] args ) throws Exception
    {
        OpenAiClient client = new OpenAiClient(
            HttpClient.newHttpClient(), 
            new ObjectMapper(), 
            "https://10.21.16.197/v1/chat/completions", 
            "llama", 
            "Qwen3.8-27B"
        );
        
        ChatRequest request = new ChatRequest(
            List.of(new Message("user", "请用一句话介绍一下Java")), 
            null, 
            null
        );

        try {
            ChatResponse response = client.chat(request);
            System.out.println("模型回复：" + response.getContent());
        } catch (IOException e) {
            System.err.println("请求失败：" + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            System.err.println("请求等待被中断");
        }

    }
}
