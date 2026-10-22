package com.example.web;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import java.io.IOException;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;

@ExtendWith(OutputCaptureExtension.class)
class ApiExceptionHandlerTest {
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new FailureController())
            .setControllerAdvice(new ApiExceptionHandler()).build();

    @ParameterizedTest
    @ValueSource(booleans = { false, true })
    void unusableResponseIsNotReportedAsModelFailureOrWrittenAgain(boolean committed, CapturedOutput output)
            throws Exception {
        var result = mvc.perform(get("/unusable-response").param("committed", Boolean.toString(committed)))
                .andExpect(status().isOk())
                .andExpect(content().string(""))
                .andExpect(header().doesNotExist("Content-Type"))
                .andReturn();

        assertInstanceOf(AsyncRequestNotUsableException.class, result.getResolvedException());
        assertFalse(output.getAll().contains("模型处理失败"));
    }

    @Test
    void upstreamIoFailureStillReturnsModelError() throws Exception {
        mvc.perform(get("/model-error"))
                .andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.code").value("MODEL_ERROR"))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("上游连接失败")));
    }

    @RestController
    static class FailureController {
        @GetMapping("/unusable-response")
        void unusableResponse(@RequestParam boolean committed, HttpServletResponse response) throws IOException {
            if (committed)
                response.flushBuffer();
            throw new AsyncRequestNotUsableException("异步响应已不可用");
        }

        @GetMapping("/model-error")
        void modelError() throws IOException {
            throw new IOException("上游连接失败");
        }
    }
}
