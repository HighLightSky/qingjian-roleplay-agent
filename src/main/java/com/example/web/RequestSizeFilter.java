package com.example.web;

import java.io.IOException;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import com.example.service.ImageValidationService;

/** 限制 JSON 请求真实读取体积，覆盖没有 Content-Length 的分块请求。 */
@Component
public class RequestSizeFilter extends OncePerRequestFilter {
    /** 读取超限时中断输入流使用，ApiExceptionHandler 依赖该标记返回 413。 */
    public static final String REQUEST_TOO_LARGE = "REQUEST_TOO_LARGE";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!request.getRequestURI().startsWith("/api/")) {
            chain.doFilter(request, response);
            return;
        }
        if (request.getContentLengthLong() > ImageValidationService.MAX_REQUEST_BYTES) {
            reject(response);
            return;
        }
        HttpServletRequestWrapper wrapped = new HttpServletRequestWrapper(request) {
            @Override
            public ServletInputStream getInputStream() throws IOException {
                ServletInputStream source = super.getInputStream();
                return new ServletInputStream() {
                    long count;

                    private void add(int n) throws IOException {
                        if (n > 0 && (count += n) > ImageValidationService.MAX_REQUEST_BYTES)
                            throw new IOException(REQUEST_TOO_LARGE);
                    }

                    @Override
                    public int read() throws IOException {
                        int v = source.read();
                        add(v < 0 ? 0 : 1);
                        return v;
                    }

                    @Override
                    public int read(byte[] b, int o, int n) throws IOException {
                        int v = source.read(b, o, n);
                        add(v);
                        return v;
                    }

                    @Override
                    public boolean isFinished() {
                        return source.isFinished();
                    }

                    @Override
                    public boolean isReady() {
                        return source.isReady();
                    }

                    @Override
                    public void setReadListener(ReadListener listener) {
                        source.setReadListener(listener);
                    }

                    @Override
                    public void close() throws IOException {
                        source.close();
                    }
                };
            }
        };
        chain.doFilter(wrapped, response);
    }

    private void reject(HttpServletResponse response) throws IOException {
        response.setStatus(413);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"code\":\"" + REQUEST_TOO_LARGE + "\",\"message\":\"请求体不能超过 64 MiB\"}");
    }
}
