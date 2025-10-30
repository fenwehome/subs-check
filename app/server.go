package app

import (
	"bufio"
	"crypto/subtle"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sinspired/subs-check/check"
	"github.com/sinspired/subs-check/config"
	"github.com/sinspired/subs-check/save/method"
	"github.com/sinspired/subs-check/utils"
	"gopkg.in/yaml.v3"
)

// initHTTPServer 初始化HTTP服务器
func (app *App) initHTTPServer() error {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery()) // 必要的 recovery

	// 仅当不是 from_subs_check 请求时，才走默认 Logger
	router.Use(func(c *gin.Context) {
		if c.Request.URL.Query().Get("from_subs_check") == "true" ||
			strings.EqualFold(c.GetHeader("X-From-Subs-Check"), "true") {
			// 静默日志
			c.Next()
		} else {
			// 调用 gin.Logger()，然后继续处理
			gin.Logger()(c)
		}
	})

	saver, err := method.NewLocalSaver()
	if err != nil {
		return fmt.Errorf("获取http监听目录失败: %w", err)
	}

	// 静态文件路由 - 订阅服务相关，始终启用
	router.StaticFile("/ACL4SSR_Online_Full.yaml", saver.OutputPath+"/ACL4SSR_Online_Full.yaml")
	// CM佬用的布丁狗
	router.StaticFile("/bdg.yaml", saver.OutputPath+"/bdg.yaml")

	// 兼容旧配置
	router.StaticFile("/sub/ACL4SSR_Online_Full.yaml", saver.OutputPath+"/ACL4SSR_Online_Full.yaml")
	// CM佬用的布丁狗
	router.StaticFile("/sub/bdg.yaml", saver.OutputPath+"/bdg.yaml")

	if config.GlobalConfig.APIKey == "" {
		if apiKey := os.Getenv("API_KEY"); apiKey != "" {
			config.GlobalConfig.APIKey = apiKey
		} else {
			config.GlobalConfig.APIKey = GenerateSimpleKey()
			slog.Warn("未设置api-key，已生成一个随机api-key", "api-key", config.GlobalConfig.APIKey)
		}
	}

	// 提供一个相对安全暴露 output 文件夹的方案
	router.Static("/"+config.GlobalConfig.APIKey+"/sub/", saver.OutputPath)

	// 提供一个用户自由分享暴露的文件夹
	moreDIR := filepath.Join(saver.OutputPath, "more")
	if err := os.MkdirAll(moreDIR, 0755); err != nil {
		return fmt.Errorf("创建用户自定义目录失败: %w", err)
	}

	router.Static("/more/", saver.OutputPath+"/more")

	// 根据配置决定是否启用Web控制面板
	if config.GlobalConfig.EnableWebUI {
		slog.Info("启用Web控制面板", "path", "http://ip:port/admin", "api-key", config.GlobalConfig.APIKey)

		// 设置模板加载 - 只有在启用Web控制面板时才加载
		router.SetHTMLTemplate(template.Must(template.New("").ParseFS(configFS, "templates/*.html")))

		// 挂载嵌入的 static 目录
		staticSub, _ := fs.Sub(staticFS, "static")
		router.StaticFS("/static", http.FS(staticSub))

		// 暴露版本号
		router.GET("/version", app.getOriginVersion)

		// 配置页面
		router.GET("/admin", func(c *gin.Context) {
			c.HTML(http.StatusOK, "admin.html", gin.H{
				"configPath": app.configPath,
			})
		})

		// 整个目录直接挂在根路径
		router.Use(app.authMiddleware(config.GlobalConfig.APIKey)) // 根路径加认证
		// router.Static("/", saver.OutputPath)

		router.GET("/all.yaml", func(c *gin.Context) {
			c.File(saver.OutputPath + "/all.yaml")
		})
		router.GET("/history.yaml", func(c *gin.Context) {
			c.File(saver.OutputPath + "/history.yaml")
		})
		router.GET("/base64.yaml", func(c *gin.Context) {
			c.File(saver.OutputPath + "/base64.yaml")
		})
		router.GET("/mihomo.yaml", func(c *gin.Context) {
			c.File(saver.OutputPath + "/mihomo.yaml")
		})

		// API路由
		api := router.Group("/api")
		api.Use(app.authMiddleware(config.GlobalConfig.APIKey)) // 添加认证中间件
		{
			// 配置相关API
			api.GET("/config", app.getConfig)
			api.POST("/config", app.updateConfig)

			// 状态相关API
			api.GET("/status", app.getStatus)
			api.POST("/trigger-check", app.triggerCheckHandler)
			api.POST("/force-close", app.forceCloseHandler)
			// 版本相关API
			api.GET("/version", app.getVersion)
			api.GET("/singbox-versions", app.getSingboxVersions)

			// 日志相关API
			api.GET("/logs", app.getLogs)
		}
	} else {
		slog.Info("Web控制面板已禁用")
	}

	// 启动HTTP服务器
	srv := &http.Server{
		Addr:    config.GlobalConfig.ListenPort,
		Handler: router,
	}
	app.httpServer = srv

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error(fmt.Sprintf("HTTP服务器启动失败: %v", err))
		}
	}()
	slog.Info("HTTP服务器启动", "port", config.GlobalConfig.ListenPort)

	return nil
}

// authMiddleware API认证中间件
func (app *App) authMiddleware(key string) gin.HandlerFunc {
	return func(c *gin.Context) {
		apiKey := c.GetHeader("X-API-Key")
		if subtle.ConstantTimeCompare([]byte(apiKey), []byte(key)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "无效的API密钥"})
			return
		}
		c.Next()
	}
}

// getConfig 获取配置文件内容
func (app *App) getConfig(c *gin.Context) {
	configData, err := os.ReadFile(app.configPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("读取配置文件失败: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"content": string(configData),
	})
}

// updateConfig 更新配置文件内容
func (app *App) updateConfig(c *gin.Context) {
	var req struct {
		Content string `json:"content"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的请求格式"})
		return
	}
	// 验证YAML格式
	var yamlData map[string]any
	if err := yaml.Unmarshal([]byte(req.Content), &yamlData); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("YAML格式错误: %v", err)})
		return
	}

	// 写入新配置
	if err := os.WriteFile(app.configPath, []byte(req.Content), 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("保存配置文件失败: %v", err)})
		return
	}

	// 配置文件监听器会自动重新加载配置
	c.JSON(http.StatusOK, gin.H{"message": "配置已更新"})
}

// getStatus 获取应用状态
func (app *App) getStatus(c *gin.Context) {
	// 准备 lastCheck 数据
	lastCheckTime := ""
	if t, ok := app.lastCheck.time.Load().(time.Time); ok && !t.IsZero() {
		lastCheckTime = t.Format("2006-01-02 15:04:05")
	}

	lastCheck := gin.H{}
	if lastCheckTime != "" || app.lastCheck.duration.Load() != 0 || app.lastCheck.Total.Load() != 0 || app.lastCheck.available.Load() != 0 {
		lastCheck = gin.H{
			"time":      lastCheckTime,
			"duration":  app.lastCheck.duration.Load(),
			"total":     app.lastCheck.Total.Load(),
			"available": app.lastCheck.available.Load(),
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"checking":   app.checking.Load(),
		"proxyCount": check.ProxyCount.Load(),
		"available":  check.Available.Load(),
		"progress":   check.Progress.Load(),
		"lastCheck":  lastCheck,
	})
}

// triggerCheckHandler 手动触发检测
func (app *App) triggerCheckHandler(c *gin.Context) {
	app.TriggerCheck()
	c.JSON(http.StatusOK, gin.H{"message": "已触发检测"})
}

// forceCloseHandler 强制关闭
func (app *App) forceCloseHandler(c *gin.Context) {
	check.ForceClose.Store(true)
	c.JSON(http.StatusOK, gin.H{"message": "已强制关闭"})
}

// getLogs 获取最近日志
func (app *App) getLogs(c *gin.Context) {
	// 简单实现，从日志文件读取最后xx行
	logPath := TempLog()

	if _, err := os.Stat(logPath); os.IsNotExist(err) {
		c.JSON(http.StatusOK, gin.H{"logs": []string{}})
		return
	}
	lines, err := ReadLastNLines(logPath, 200)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("读取日志失败: %v", err)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"logs": lines})
}

// getLogs 获取版本号
func (app *App) getVersion(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"version": app.version})
}

// getOriginVersion 获取原始程序版本
func (app *App) getOriginVersion(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"version": app.originVersion})
}

// getSingboxVersions 获取 singbox 版本
func (app *App) getSingboxVersions(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"latest": utils.LatestSingboxVersion,
		"old":    utils.OldSingboxVersion,
	})
}

func ReadLastNLines(filePath string, n int) ([]string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	ring := make([]string, n)
	count := 0

	// 使用环形缓冲区读取
	for scanner.Scan() {
		ring[count%n] = scanner.Text()
		count++
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	// 处理结果
	if count <= n {
		return ring[:count], nil
	}

	// 调整顺序，从最旧到最新
	start := count % n
	result := append(ring[start:], ring[:start]...)
	return result, nil
}

func GenerateSimpleKey() string {
	return fmt.Sprintf("%06d", time.Now().UnixNano()%1000000)
}
