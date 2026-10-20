package com.example;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

// @ConfigurationPropertiesScan 会扫描 com.example 包下
// 所有 @ConfigurationProperties 类并注册成 Bean

@SpringBootApplication 
@ConfigurationPropertiesScan
public class RoleplayApplication {
    public static void main(String[] args) {
        SpringApplication.run(RoleplayApplication.class, args);
    }
}
