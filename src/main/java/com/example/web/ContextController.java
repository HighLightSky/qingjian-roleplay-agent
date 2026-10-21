package com.example.web;

import com.example.service.VisualSelectionService;
import com.example.service.ContextBudgetService;
import com.example.service.ContextCompactionService;
import com.example.web.dto.ContextDtos.*;
import com.example.web.dto.ChatApiRequest;
import com.example.web.dto.VisualDtos.Plan;
import org.springframework.web.bind.annotation.*;
import java.io.IOException;

/** 无状态选图入口：返回计划，原图由浏览器随后按需补传。 */
@RestController
public class ContextController {
    private final VisualSelectionService service;
    private final ContextBudgetService budgets;
    private final ContextCompactionService compaction;

    public ContextController(VisualSelectionService service, ContextBudgetService budgets, ContextCompactionService compaction) {
        this.service = service;
        this.budgets = budgets;
        this.compaction = compaction;
    }

    @PostMapping("/api/context/budget")
    public ContextBudget budget(@RequestBody BudgetRequest request) throws IOException, InterruptedException {
        return budgets.inspect(request);
    }

    @PostMapping("/api/context/compact")
    public CompactionResult compact(@RequestBody CompactionRequest request) throws IOException, InterruptedException {
        return compaction.compact(request);
    }

    @PostMapping("/api/context/inspect")
    public Plan inspect(@RequestBody ChatApiRequest request) throws IOException, InterruptedException {
        return service.select(request);
    }
}
