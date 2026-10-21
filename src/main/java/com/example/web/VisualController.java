package com.example.web;

import com.example.service.VisualUpdateService;
import com.example.web.dto.VisualDtos.*;
import org.springframework.web.bind.annotation.*;
import java.io.IOException;

/** 独立视觉整理入口，正文完成后调用，可在浏览器恢复任务时重试。 */
@RestController
public class VisualController {
    private final VisualUpdateService service;

    public VisualController(VisualUpdateService service) {
        this.service = service;
    }

    @PostMapping("/api/visual/update")
    public UpdateResponse update(@RequestBody UpdateRequest request) throws IOException, InterruptedException {
        return service.update(request);
    }
}
