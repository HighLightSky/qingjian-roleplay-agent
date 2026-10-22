package com.example.service;

import java.util.concurrent.Semaphore;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/** 一个名额覆盖整条生成链，避免阶段之间被其他模型请求插入。 */
@Component
public class ModelGate {
    private final Semaphore semaphore = new Semaphore(1);

    public Lease acquire() {
        if (!semaphore.tryAcquire())
            throw new DispatchException(HttpStatus.CONFLICT, "MODEL_BUSY", "模型正在执行其他任务，请稍后再试");
        return new Lease();
    }

    public final class Lease implements AutoCloseable {
        private boolean released;

        @Override
        public synchronized void close() {
            if (!released) {
                released = true;
                semaphore.release();
            }
        }
    }
}
