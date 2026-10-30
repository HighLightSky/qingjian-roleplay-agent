package com.example.service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import com.example.config.ImageGenerationProperties;
import com.example.image.QwenImageClient;
import com.example.image.QwenImageClient.ServiceError;
import com.example.web.dto.SceneImageDtos.*;

@Service
public class PoseSearchService {
    private final QwenImageClient client;
    private final PoseValidation validation;
    private final ImageGenerationProperties config;

    public PoseSearchService(QwenImageClient client, PoseValidation validation, ImageGenerationProperties config) {
        this.client = client;
        this.validation = validation;
        this.config = config;
    }

    public PoseSearchResult search(PoseSearchRequest request) throws IOException, InterruptedException {
        if (request == null)
            throw new IllegalArgumentException("姿态检索请求不能为空");
        validation.search(request);
        if (config.apiToken().isBlank())
            throw new DispatchException(HttpStatus.SERVICE_UNAVAILABLE, "GENERATION_NOT_CONFIGURED", "未配置生图服务 Token");
        var result = client.searchPoses(request.query(), request.library());
        var matches = result.path("matches");
        if (!matches.isArray() || matches.size() > config.poseSearchTopK())
            throw new ServiceError(502, "INVALID_POSE_RESPONSE", "姿态检索返回了无效的候选数组");
        var selected = new ArrayList<PoseSelection>();
        var ids = new HashSet<String>();
        for (var match : matches) {
            if (!match.path("pose_id").isTextual() || !match.path("score").isNumber()
                    || !match.path("description").path("zh").isTextual()
                    || !match.path("description").path("en").isTextual())
                throw new ServiceError(502, "INVALID_POSE_RESPONSE", "姿态检索候选缺少必要字段");
            var candidate = new PoseSelection(match.get("pose_id").textValue(), match.get("score").doubleValue(),
                    new PoseDescription(match.path("description").get("zh").textValue(),
                            match.path("description").get("en").textValue()), match.get("pose"));
            try {
                validation.selection(candidate);
            } catch (IllegalArgumentException e) {
                throw new ServiceError(502, "INVALID_POSE_RESPONSE", "姿态检索候选无效：" + e.getMessage());
            }
            if (!ids.add(candidate.poseId()))
                throw new ServiceError(502, "INVALID_POSE_RESPONSE", "姿态检索返回了重复候选");
            selected.add(candidate);
        }
        return new PoseSearchResult(selected);
    }
}
