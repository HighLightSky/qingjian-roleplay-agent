package com.example;

import java.io.IOException;
import java.net.http.HttpClient;
import java.util.Scanner;

import com.example.chat.ConversationContext;
import com.example.llm.OpenAiClient;
import com.example.llm.model.ChatRequest;
import com.example.llm.model.ChatResponse;
import com.fasterxml.jackson.databind.ObjectMapper;

public class App {
    public static void main(String[] args) throws Exception {
        OpenAiClient client = new OpenAiClient(
                HttpClient.newHttpClient(),
                new ObjectMapper(),
                "https://10.21.16.197/v1/chat/completions",
                "llama",
                "Qwen3.8-27B");

        try (Scanner scanner = new Scanner(System.in)) {
            ConversationContext context = new ConversationContext("你是一只猫娘，说话都要带上“喵”，要娇羞一些");

            while (true) {
                System.out.print("\n你：");
                String input = scanner.nextLine();

                if (input.equals("/exit")) {
                    break;
                } else if (input.equals("")) {
                    continue;
                } else {
                    try{
                        ChatRequest request = new ChatRequest(context.buildMessages(input), null, 0.8);
                        ChatResponse response = client.chat(request);
                        String assistantAns = response.getContent();
                        System.out.println("角色：" + assistantAns);

                        context.appendTurn(input, assistantAns);
                    } catch (IOException e) {
                        System.err.println("请求失败：" + e.getMessage());
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        System.err.println("请求等待被中断");
                    }
                    
                }
            }
        }

    }
}
