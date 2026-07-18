-- Safari 启动扩展页面 workaround
-- 作用：Safari 启动后自动新建一个标签页，触发 chrome_url_overrides.newtab 扩展覆盖
-- 使用方法：把这个脚本保存后，通过系统设置 -> 登录项 添加，或用 launchd 定时触发

on run
	-- 等待 Safari 启动完成
	tell application "Safari"
		if not running then
			activate
			delay 3
		else
			activate
		end if
	end tell

	-- 确保 Safari 在最前面
	tell application "System Events"
		tell process "Safari"
			set frontmost to true
		end tell
	end tell

	delay 1

	-- 发送 ⌘T 新建标签，触发扩展 newtab 覆盖
	tell application "System Events"
		keystroke "t" using {command down}
	end tell
end run
