package com.example.service;

import com.example.web.dto.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

/** 请求材料的共同信任边界；原图字节由图片校验器另行核验。 */
@Component
public class ContextValidation {

    public void validate(ChatApiRequest r) {
        if (r == null)
            throw new IllegalArgumentException("上下文不能为空");
        CharacterDto.validate(r.character());
        StateValidation.snapshot(r.state());
        if (r.summary() == null)
            throw new IllegalArgumentException("历史摘要缺失");
        StateValidation.text(r.summary().text());
        if (r.history().size() > ContextLimits.COLLECTION_ITEMS || r.input() == null || r.interactionSettings() == null
                || r.interactionSettings().replyLength() == null || r.interactionSettings().narrativeMode() == null)
            throw new IllegalArgumentException("历史、输入或交互设置缺失");
        StateValidation.id(r.operationId());
        StateValidation.text(r.input().textOf());
        StateValidation.collection(r.input().content(), "输入内容块");
        int previous = r.summary().throughSeq();
        var ids = new java.util.HashSet<String>();
        for (HistoryMessageDto h : r.history()) {
            if (h == null || h.role() == null || !java.util.Set.of("user", "assistant").contains(h.role())
                    || h.text() == null)
                throw new IllegalArgumentException("历史消息的角色或内容无效");
            StateValidation.id(h.id());
            if (!ids.add(h.id()) || h.seq() <= previous || h.checkpointVersion() < 0 || h.status() == null
                    || !java.util.Set.of("complete", "cancelled", "error", "interrupted").contains(h.status()))
                throw new IllegalArgumentException("历史消息顺序、版本或状态无效");
            StateValidation.collection(h.parts(), "历史内容块");
            previous = h.seq();
        }
        if (r.visual() != null && !r.state().sessionId().equals(r.visual().sessionId()))
            throw new IllegalArgumentException("图片与领域快照不属于同一会话");
    }
}
