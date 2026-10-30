package com.example.service;

import java.io.IOException;
import java.util.Map;
import java.util.ArrayDeque;
import org.springframework.stereotype.Service;
import com.example.config.ImageGenerationProperties;
import com.example.web.dto.SceneImageDtos.PoseSelection;
import com.example.web.dto.SceneImageDtos.PoseSearchRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;

/** 仅在检索响应和生图提交两个信任边界校验姿势，不裁剪内部字段。 */
@Service
public class PoseValidation {
    private final ImageGenerationProperties config;
    private final ObjectMapper mapper;

    public PoseValidation(ImageGenerationProperties config, ObjectMapper mapper) {
        this.config = config;
        this.mapper = mapper;
    }

    public void query(String query) throws IOException {
        if (query == null || query.isBlank())
            throw new IllegalArgumentException("姿态检索描述不能为空");
    }

    public void search(PoseSearchRequest request) throws IOException {
        query(request.query());
        if (!java.util.Set.of("default", "mixamo", "all").contains(request.library()))
            throw new IllegalArgumentException("library 必须是 default、mixamo 或 all");
        if (mapper.writeValueAsBytes(Map.of("query", request.query(), "top_k", config.poseSearchTopK(),
                "library", request.library())).length
                > config.poseSearchMaxRequestBytes())
            throw new IllegalArgumentException("姿态检索请求体超限");
    }

    public void selection(PoseSelection selection) throws IOException {
        if (selection == null || selection.poseId() == null || selection.poseId().isBlank()
                || selection.score() == null || !Double.isFinite(selection.score()) || selection.description() == null
                || selection.description().zh() == null || selection.description().zh().isBlank()
                || selection.description().en() == null || selection.description().en().isBlank())
            throw new IllegalArgumentException("姿势候选缺少有效标识、相似度或中英文描述");
        if (selection.pose() == null || !selection.pose().isObject())
            throw new IllegalArgumentException("姿势 JSON 顶层必须是对象");
        var pose = selection.pose();
        if (!pose.has("bones") && !pose.has("characters") && !pose.has("poses") && !pose.has("image_poses"))
            throw new IllegalArgumentException("姿势 JSON 缺少 bones、characters、poses 或 image_poses 标识字段");
        var pending = new ArrayDeque<JsonNode>();
        pending.push(pose);
        while (!pending.isEmpty()) {
            var node = pending.pop();
            if (node.isFloatingPointNumber() && !Double.isFinite(node.doubleValue()))
                throw new IllegalArgumentException("姿势 JSON 不能包含 NaN 或 Infinity");
            if (node.isContainerNode()) node.forEach(pending::push);
        }
        if (mapper.writeValueAsBytes(selection.pose()).length > config.poseMaxBytes())
            throw new IllegalArgumentException("姿势 JSON 超过大小限制（" + config.poseMaxBytes() + " 字节）");
    }
}
