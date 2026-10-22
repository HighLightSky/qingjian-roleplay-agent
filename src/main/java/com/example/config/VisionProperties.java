package com.example.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/** 部署级视觉能力与资源限制；由配置启用，前端不提供图片模式开关。 */
@Component
@ConfigurationProperties(prefix = "roleplay.vision")
public class VisionProperties {
    private boolean supported = false;
    private int maxImages = 4;
    private long maxImageBytes = 10L * 1024 * 1024;
    private long maxPixels = 20_000_000;

    public boolean isSupported() {
        return supported;
    }

    public void setSupported(boolean value) {
        supported = value;
    }

    public int getMaxImages() {
        return maxImages;
    }

    public void setMaxImages(int value) {
        maxImages = value;
    }

    public long getMaxImageBytes() {
        return maxImageBytes;
    }

    public void setMaxImageBytes(long value) {
        maxImageBytes = value;
    }

    public long getMaxPixels() {
        return maxPixels;
    }

    public void setMaxPixels(long value) {
        maxPixels = value;
    }

}
