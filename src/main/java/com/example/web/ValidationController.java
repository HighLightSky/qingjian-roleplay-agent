package com.example.web;

import com.example.service.StateValidation;
import com.example.web.dto.CharacterDto;
import com.example.web.dto.StateDtos.Snapshot;
import org.springframework.web.bind.annotation.*;

/** 本地人工编辑在落库前使用与模型请求一致的后端校验。 */
@RestController
@RequestMapping("/api/validate")
public class ValidationController {
    @PostMapping("/character")
    public void character(@RequestBody CharacterDto character) { CharacterDto.validate(character); }
    @PostMapping("/state")
    public void state(@RequestBody Snapshot snapshot) { StateValidation.snapshot(snapshot); }
}
