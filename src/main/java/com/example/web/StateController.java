package com.example.web;

import java.io.IOException;
import org.springframework.web.bind.annotation.*;
import com.example.service.StateUpdateService;
import com.example.web.dto.StateDtos.*;

/** 正文成功保存后统一检查视觉、剧情、记忆和目标。 */
@RestController
public class StateController {
    private final StateUpdateService service;
    public StateController(StateUpdateService service) { this.service = service; }
    @PostMapping("/api/state/update")
    public Result update(@RequestBody UpdateRequest request) throws IOException, InterruptedException {
        return service.update(request);
    }
}
