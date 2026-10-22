package com.example.web;

import com.example.service.VisualSelectionService;
import com.example.service.ContextBudgetService;
import com.example.service.ContextCompactionService;
import com.example.web.dto.ContextDtos.*;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.VisualDtos.Plan;
import org.springframework.web.bind.annotation.*;
import java.io.IOException;

/** 生成前的只读预算预览与有界历史压缩。 */
@RestController
public class ContextController {
    private final ContextBudgetService budgets;
    private final ContextCompactionService compaction;
    private final com.example.service.ModelGate gate;

    public ContextController(ContextBudgetService budgets, ContextCompactionService compaction, com.example.service.ModelGate gate) {
        this.gate = gate;
        this.budgets = budgets;
        this.compaction = compaction;
    }

    @PostMapping("/api/context/budget")
    public ContextBudget budget(@RequestBody BudgetRequest request) throws IOException, InterruptedException {
        return budgets.inspect(request);
    }

    @PostMapping("/api/context/compact")
    public CompactionResult compact(@RequestBody CompactionRequest request) throws IOException, InterruptedException {
        try (var permit = gate.acquire()) { return compaction.compact(request); }
    }

}
