package com.example.chat;

import java.util.ArrayList;
import java.util.List;

import com.example.llm.model.Message;

public class ConversationContext {
    private final Message systemMessage;
    private final List<Message> history;

    public ConversationContext(String systemPrompt){
        this.systemMessage = new Message("system", systemPrompt);
        this.history = new ArrayList<>();
    }

    public List<Message> buildMessages(String userInput) {
        List<Message> messages = new ArrayList<>();

        messages.add(systemMessage);
        messages.addAll(history);
        messages.add(new Message("user", userInput));

        return messages;
    }

    public void appendTurn(String userInput, String assistantReply) {
        history.add(new Message("user", userInput));
        history.add(new Message("assistant", assistantReply));
    }
}
