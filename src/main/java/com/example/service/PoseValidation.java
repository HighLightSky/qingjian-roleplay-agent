package com.example.service;

import java.io.IOException;
import java.util.Map;
import org.springframework.stereotype.Service;
import com.example.config.ImageGenerationProperties;
import com.example.web.dto.SceneImageDtos.PoseSelection;
import com.fasterxml.jackson.databind.ObjectMapper;

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
        if (mapper.writeValueAsBytes(Map.of("query", query, "top_k", config.poseSearchTopK())).length
                > config.poseSearchMaxRequestBytes())
            throw new IllegalArgumentException("姿态检索请求体超限");
    }

    public void selection(PoseSelection selection) throws IOException {
        if (selection == null || selection.poseId() == null || selection.poseId().isBlank()
                || selection.score() == null || !Double.isFinite(selection.score()) || selection.description() == null
                || selection.description().zh() == null || selection.description().zh().isBlank()
                || selection.description().en() == null || selection.description().en().isBlank())
            throw new IllegalArgumentException("姿势候选缺少有效标识、相似度或中英文描述");
        if (selection.pose() == null || !selection.pose().isObject() || selection.pose().isEmpty())
            throw new IllegalArgumentException("姿势候选必须包含完整的非空 pose 对象");
        if (mapper.writeValueAsBytes(selection.pose()).length > config.poseMaxBytes())
            throw new IllegalArgumentException("姿势对象超过体积限制");
    }
}
