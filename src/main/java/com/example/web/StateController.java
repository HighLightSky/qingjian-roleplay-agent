package com.example.web;

import java.io.IOException;
import java.util.LinkedHashSet;
import org.springframework.web.bind.annotation.*;
import com.example.service.*;
import com.example.web.dto.DispatchDtos.Retry;
import com.example.web.dto.StateDtos.*;

/** 仅供最新失败步骤手动重试，不承担自动补做。 */
@RestController
public class StateController {
    private final StateUpdateService service;
    private final ContextValidation contexts;
    private final ImageValidationService images;
    private final ImageCache cache;
    private final ModelGate gate;
    public StateController(StateUpdateService service, ContextValidation contexts, ImageValidationService images,
            ImageCache cache, ModelGate gate) {
        this.service = service; this.contexts = contexts; this.images = images; this.cache = cache; this.gate = gate;
    }
    @PostMapping("/api/state/update")
    public Result update(@RequestBody Retry retry) throws IOException, InterruptedException {
        var request = retry.request();
        contexts.validate(request.context());
        images.validateReferences(request.context());
        try (var permit = gate.acquire(); var pinned = cache.pin(retry.images())) {
            pinned.validateCatalog(request.context());
            var ids = new LinkedHashSet<>(ImageValidationService.requiredIds(request.context()));
            if (request.context().visual() != null && request.context().visual().plan() != null)
                request.context().visual().plan().selectedHistoricalImages().forEach(s -> ids.add(s.assetId()));
            var prepared = new UpdateRequest(request.operationId(),
                    ChatDispatchService.withImages(request.context(), request.context().visual() == null ? null : request.context().visual().plan(), pinned.payloads(ImageObservationPolicy.observationAssetIds(request.context(), ids))),
                    request.fromExclusiveSeq(), request.throughSeq(), request.assistantCheckpointVersion(), request.messages());
            service.validateRequest(prepared);
            return service.update(prepared);
        }
    }
}
