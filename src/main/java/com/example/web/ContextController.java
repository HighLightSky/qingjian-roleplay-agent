package com.example.web;

import com.example.service.VisualSelectionService;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.VisualDtos.Plan;
import org.springframework.web.bind.annotation.*;
import java.io.IOException;

/** 无状态选图入口：返回计划，原图由浏览器随后按需补传。 */
@RestController
public class ContextController {
    private final VisualSelectionService service;

    public ContextController(VisualSelectionService service) {
        this.service = service;
    }

    @PostMapping("/api/context/inspect")
    public Plan inspect(@RequestBody ChatApiRequest request) throws IOException, InterruptedException {
        return service.select(request);
    }
}
