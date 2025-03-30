import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import minimist from 'minimist';

const execAsync = promisify(exec);

// ======================
// Configuration Setup
// ======================
const args = minimist(process.argv.slice(2));
const COMMANDS_FILE = path.resolve(args.file || "commands.json");
const LOGS_DIR = path.resolve(args.logs || "logs");
const PORT = args.port || 3000;

console.log(`Starting service with:
  Commands file: ${COMMANDS_FILE}
  Logs directory: ${LOGS_DIR}
  Working directory: ${process.cwd()}
  PID: ${process.pid}
`);

// ======================
// File System Utilities
// ======================
function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`Created directory: ${dirPath}`);
  }
}

function getCurrentDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function getTodayLogFile() {
  ensureDirectory(LOGS_DIR);
  return path.join(LOGS_DIR, `${getCurrentDateString()}.json`);
}

// ======================
// Logging System
// ======================
function initLogSystem() {
  const todayLogFile = getTodayLogFile();
  if (!fs.existsSync(todayLogFile)) {
    fs.writeFileSync(todayLogFile, JSON.stringify([{
      timestamp: new Date().toISOString(),
      action: 'service_started',
      version: '2.6.1',
      configFile: COMMANDS_FILE,
      logDir: LOGS_DIR,
      pid: process.pid
    }], null, 2));
  }
}

function logAction(action, details = {}) {
  const todayLogFile = getTodayLogFile();
  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    pid: process.pid,
    ...details
  };

  try {
    let logs = [];
    if (fs.existsSync(todayLogFile)) {
      const logData = fs.readFileSync(todayLogFile, 'utf8');
      logs = logData ? JSON.parse(logData) : [];
    }
    logs.push(logEntry);
    fs.writeFileSync(todayLogFile, JSON.stringify(logs, null, 2));
  } catch (err) {
    console.error('Log write failed:', err);
  }
}

// ======================
// Command Configuration
// ======================
function ensureCommandsFile() {
  ensureDirectory(path.dirname(COMMANDS_FILE));
  
  if (!fs.existsSync(COMMANDS_FILE)) {
    const defaultCommands = [
      {
        name: "dir",
        description: "List directory contents",
        example: "dir /w",
        dangerous: false,
        enabled: true,
        confirmationPrompt: "",
        consequences: ""
      },
      {
        name: "ping",
        description: "Test network connection",
        example: "ping example.com",
        dangerous: false,
        enabled: true,
        confirmationPrompt: "",
        consequences: ""
      },
      {
        name: "format",
        description: "Format disk drive",
        example: "format C:",
        dangerous: true,
        enabled: false,
        confirmationPrompt: "This will PERMANENTLY erase all data. Confirm?",
        consequences: "Permanent data loss"
      }
    ];
    fs.writeFileSync(COMMANDS_FILE, JSON.stringify(defaultCommands, null, 2));
    console.log(`Created new commands file at: ${COMMANDS_FILE}`);
    logAction('config_file_created', { file: COMMANDS_FILE });
  }
}

function verifyFileAccess() {
  try {
    fs.accessSync(COMMANDS_FILE, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (err) {
    console.error(`Cannot access commands file: ${err.message}`);
    return false;
  }
}

function loadCommands() {
  try {
    if (!fs.existsSync(COMMANDS_FILE)) {
      throw new Error(`Commands file not found at ${COMMANDS_FILE}`);
    }
    const data = fs.readFileSync(COMMANDS_FILE, 'utf8');
    const commands = JSON.parse(data);
    
    if (!Array.isArray(commands)) {
      throw new Error("Invalid command config format");
    }
    
    return commands;
  } catch (err) {
    logAction('config_load_failed', { error: err.message });
    throw err;
  }
}

function saveCommands(commands) {
  try {
    const tmpFile = `${COMMANDS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(commands, null, 2));
    fs.renameSync(tmpFile, COMMANDS_FILE);
    logAction('config_saved', { count: commands.length });
    return true;
  } catch (err) {
    logAction('config_save_failed', { error: err.message });
    return false;
  }
}

// ======================
// Process Management
// ======================
function setupProcessHandlers() {
  process.on('exit', (code) => {
    logAction('service_stopped', { code });
  });

  process.on('uncaughtException', (err) => {
    logAction('uncaught_exception', { error: err.message });
    console.error('Critical error:', err);
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    logAction('service_terminated');
    process.exit(0);
  });

  // File watching only in development
  if (process.env.NODE_ENV !== 'production') {
    fs.watch(COMMANDS_FILE, (eventType) => {
      console.log(`Commands file ${eventType} detected`);
      logAction('config_file_changed', { eventType });
    });
  }
}

// ======================
// MCP Server Setup
// ======================
const server = new McpServer({
  name: "Secure Command Executor",
  version: "2.6.1",
  description: "Robust command execution service with daily log rotation",
  endpoints: {
    http: `http://localhost:${PORT}`
  }
});

// ======================
// Initialization
// ======================
setupProcessHandlers();
ensureCommandsFile();
initLogSystem();

if (!verifyFileAccess()) {
  console.error('Fatal: Cannot access commands file');
  process.exit(1);
}

logAction('service_initialized');

// ======================
// Tool Implementations
// ======================

// 1. Command Execution Tool
server.tool("execute", {
  command: z.string().min(1).max(200),
  args: z.string().optional(),
  confirmationToken: z.string().optional(),
  requestId: z.string().optional()
}, async ({ command, args, confirmationToken, requestId }) => {
  const startTime = Date.now();
  const fullCommand = args ? `${command} ${args}` : command;
  
  try {
    const commands = loadCommands();
    const cmdConfig = commands.find(c => c.name === command);
    
    if (!cmdConfig) {
      logAction('command_not_found', { requestId, command });
      return { content: [{ type: "text", text: `Error: Unknown command "${command}"` }] };
    }

    if (!cmdConfig.enabled) {
      logAction('command_disabled', { requestId, command });
      return { content: [{ type: "text", text: `Error: Command "${command}" is disabled` }] };
    }

    if (cmdConfig.dangerous) {
      if (!confirmationToken) {
        logAction('dangerous_command_attempt', { requestId, command: fullCommand });
        return {
          content: [{
            type: "text",
            text: `⚠️ DANGEROUS COMMAND WARNING ⚠️\n\n` +
                  `Command: ${command}\n` +
                  `Description: ${cmdConfig.description}\n` +
                  `Potential Consequences: ${cmdConfig.consequences}\n\n` +
                  `Safety Confirmation: ${cmdConfig.confirmationPrompt}\n\n` +
                  `To execute, include: "confirmationToken":"I understand the risks and confirm execution"`
          }],
          requiresConfirmation: true
        };
      }
      
      if (confirmationToken !== "I understand the risks and confirm execution") {
        logAction('dangerous_command_rejected', {
          requestId,
          command: fullCommand,
          reason: 'invalid_confirmation_token'
        });
        return { content: [{ type: "text", text: `Error: Invalid confirmation token` }] };
      }

      logAction('dangerous_command_confirmed', { requestId, command: fullCommand });
    }

    const { stdout, stderr } = await execAsync(fullCommand, { windowsHide: true });
    const executionTime = Date.now() - startTime;
    
    logAction('command_executed', {
      requestId,
      command: fullCommand,
      status: 'success',
      executionTime,
      outputLength: (stdout || stderr || '').length
    });

    return { content: [{ type: "text", text: stdout || stderr || "Command executed with no output" }] };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logAction('command_failed', {
      requestId,
      command: fullCommand,
      status: 'error',
      error: error.message,
      executionTime
    });
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

// 2. Command Query Tool
server.tool("queryCommands", {
  filter: z.enum(["all", "enabled", "disabled", "dangerous"]).optional().default("enabled"),
  detailed: z.boolean().optional().default(false),
  requestId: z.string().optional()
}, async ({ filter, detailed, requestId }) => {
  try {
    const commands = loadCommands();
    
    let filteredCommands = commands;
    if (filter === "enabled") filteredCommands = commands.filter(c => c.enabled);
    else if (filter === "disabled") filteredCommands = commands.filter(c => !c.enabled);
    else if (filter === "dangerous") filteredCommands = commands.filter(c => c.dangerous);
    
    const commandList = filteredCommands.map(c => {
      let info = `${c.name}${c.dangerous ? ' ⚠️' : ''}${!c.enabled ? ' (disabled)' : ''}`;
      if (detailed) {
        info += `\nDescription: ${c.description}` +
                `\nExample: ${c.example}` +
                (c.dangerous ? `\nConsequences: ${c.consequences}` : '');
      }
      return info;
    });
    
    logAction('commands_queried', {
      requestId,
      filter,
      count: filteredCommands.length
    });

    return {
      content: [{
        type: "text",
        text: `Available commands (${filter}, ${filteredCommands.length}):\n\n${commandList.join('\n\n')}`
      }]
    };
  } catch (error) {
    logAction('query_failed', {
      requestId,
      error: error.message
    });
    return {
      content: [{
        type: "text",
        text: `Query failed: ${error.message}`
      }]
    };
  }
});

// 3. Command Management Tool
server.tool("manageCommand", {
  action: z.enum(["add", "update", "remove", "enable", "disable", "list"]),
  name: z.string().min(1).max(50).optional(),
  description: z.string().optional(),
  example: z.string().optional(),
  dangerous: z.boolean().optional(),
  confirmationPrompt: z.string().optional(),
  consequences: z.string().optional(),
  enabled: z.boolean().optional(),
  requestId: z.string().optional()
}, async (params) => {
  const { action, requestId } = params;
  let commands, message, updated = false;
  
  try {
    commands = loadCommands();
    
    switch (action) {
      case "add":
        if (!params.name) {
          message = "Error: Command name is required";
          break;
        }
        
        if (commands.some(c => c.name === params.name)) {
          message = `Error: Command "${params.name}" already exists`;
          break;
        }
        
        const newCmd = {
          name: params.name,
          description: params.description || "No description",
          example: params.example || "No example",
          dangerous: params.dangerous || false,
          enabled: params.enabled ?? (!params.dangerous),
          confirmationPrompt: params.dangerous ? 
            (params.confirmationPrompt || "Confirm execution of this dangerous operation?") : "",
          consequences: params.dangerous ? 
            (params.consequences || "May cause system damage or data loss") : ""
        };
        
        commands.push(newCmd);
        updated = true;
        message = `Added command: ${params.name}`;
        logAction('command_added', {
          requestId,
          name: params.name,
          dangerous: newCmd.dangerous,
          enabled: newCmd.enabled
        });
        break;
        
      case "update":
        if (!params.name) {
          message = "Error: Command name is required";
          break;
        }
        
        const cmdIndex = commands.findIndex(c => c.name === params.name);
        if (cmdIndex === -1) {
          message = `Error: Command "${params.name}" not found`;
          break;
        }
        
        const cmd = commands[cmdIndex];
        const changes = {};
        
        if (params.description !== undefined) {
          changes.description = params.description;
          cmd.description = params.description;
        }
        if (params.example !== undefined) {
          changes.example = params.example;
          cmd.example = params.example;
        }
        if (params.enabled !== undefined) {
          changes.enabled = params.enabled;
          cmd.enabled = params.enabled;
        }
        
        if (params.dangerous !== undefined) {
          changes.dangerous = params.dangerous;
          cmd.dangerous = params.dangerous;
          
          if (params.dangerous) {
            cmd.confirmationPrompt = params.confirmationPrompt || cmd.confirmationPrompt;
            cmd.consequences = params.consequences || cmd.consequences;
          } else {
            cmd.confirmationPrompt = "";
            cmd.consequences = "";
          }
        }
        
        updated = true;
        message = `Updated command: ${params.name}`;
        logAction('command_updated', {
          requestId,
          name: params.name,
          changes
        });
        break;
        
      case "remove":
        if (!params.name) {
          message = "Error: Command name is required";
          break;
        }
        
        const removeIndex = commands.findIndex(c => c.name === params.name);
        if (removeIndex === -1) {
          message = `Error: Command "${params.name}" not found`;
          break;
        }
        
        const removedCmd = commands[removeIndex];
        commands.splice(removeIndex, 1);
        updated = true;
        message = `Removed command: ${params.name}`;
        logAction('command_removed', {
          requestId,
          name: params.name,
          wasDangerous: removedCmd.dangerous
        });
        break;
        
      case "enable":
        if (!params.name) {
          message = "Error: Command name is required";
          break;
        }
        
        const enableCmd = commands.find(c => c.name === params.name);
        if (!enableCmd) {
          message = `Error: Command "${params.name}" not found`;
          break;
        }
        
        enableCmd.enabled = true;
        updated = true;
        message = `Enabled command: ${params.name}`;
        logAction('command_enabled', {
          requestId,
          name: params.name
        });
        break;
        
      case "disable":
        if (!params.name) {
          message = "Error: Command name is required";
          break;
        }
        
        const disableCmd = commands.find(c => c.name === params.name);
        if (!disableCmd) {
          message = `Error: Command "${params.name}" not found`;
          break;
        }
        
        disableCmd.enabled = false;
        updated = true;
        message = `Disabled command: ${params.name}`;
        logAction('command_disabled', {
          requestId,
          name: params.name
        });
        break;
        
      case "list":
        const enabledCount = commands.filter(c => c.enabled).length;
        const dangerousCount = commands.filter(c => c.dangerous).length;
        message = `Total commands: ${commands.length}\nEnabled: ${enabledCount}\nDangerous: ${dangerousCount}`;
        logAction('command_listed', {
          requestId,
          total: commands.length,
          enabled: enabledCount,
          dangerous: dangerousCount
        });
        break;
    }
    
    if (updated && !saveCommands(commands)) {
      message = "Operation succeeded but failed to save config";
    }
    
    return {
      content: [{
        type: "text",
        text: message
      }]
    };
  } catch (error) {
    logAction('management_failed', {
      requestId,
      action,
      error: error.message
    });
    return {
      content: [{
        type: "text",
        text: `Management operation failed: ${error.message}`
      }]
    };
  }
});

// 4. Log Query Tool
server.tool("queryLogs", {
  limit: z.number().int().positive().max(1000).optional().default(100),
  filter: z.string().optional(),
  requestId: z.string().optional()
}, async ({ limit, filter, requestId }) => {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      return {
        content: [{
          type: "text",
          text: "No logs available - log directory not found"
        }]
      };
    }

    const logFiles = fs.readdirSync(LOGS_DIR)
      .filter(file => file.endsWith('.json'))
      .sort()
      .reverse()
      .map(file => path.join(LOGS_DIR, file));
    
    let allLogs = [];
    
    for (const logFile of logFiles) {
      try {
        const logData = fs.readFileSync(logFile, 'utf8');
        const logs = logData ? JSON.parse(logData) : [];
        
        const filteredLogs = filter ? 
          logs.filter(entry => 
            entry.action.includes(filter) || 
            (entry.command && entry.command.includes(filter)) ||
            (entry.name && entry.name.includes(filter))
          ) : logs;
        
        allLogs = [...allLogs, ...filteredLogs];
        
        if (allLogs.length >= limit) {
          allLogs = allLogs.slice(0, limit);
          break;
        }
      } catch (err) {
        console.error(`Error reading log file ${logFile}:`, err);
      }
    }
    
    logAction('logs_queried', {
      requestId,
      count: allLogs.length,
      filter
    });

    return {
      content: [{
        type: "text",
        text: `Recent ${allLogs.length} log entries:\n\n${allLogs.map(entry => 
          `${entry.timestamp} [${entry.action}] ${
            entry.command ? `Command: ${entry.command}` : 
            entry.name ? `Name: ${entry.name}` : ''
          } ${entry.status || ''}`
        ).join('\n')}`
      }]
    };
  } catch (error) {
    logAction('log_query_failed', {
      requestId,
      error: error.message
    });
    return {
      content: [{
        type: "text",
        text: `Log query failed: ${error.message}`
      }]
    };
  }
});

// ======================
// Resource Endpoints
// ======================
server.resource("commands", new ResourceTemplate("cmd://commands", { list: undefined }), async () => {
  try {
    const commands = loadCommands();
    return {
      contents: [{
        uri: "cmd://commands",
        text: JSON.stringify(commands, null, 2),
        metadata: { "content-type": "application/json" }
      }]
    };
  } catch (error) {
    return {
      contents: [{
        uri: "cmd://commands",
        text: `Error loading commands: ${error.message}`
      }]
    };
  }
});

server.resource("command", new ResourceTemplate("cmd://command/{name}", { list: undefined }), async (uri, { name }) => {
  try {
    const commands = loadCommands();
    const command = commands.find(cmd => cmd.name === name);
    
    if (!command) {
      return {
        contents: [{
          uri: uri.href,
          text: `Command not found: ${name}`
        }]
      };
    }
    
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(command, null, 2),
        metadata: { "content-type": "application/json" }
      }]
    };
  } catch (error) {
    return {
      contents: [{
        uri: uri.href,
        text: `Error loading command: ${error.message}`
      }]
    };
  }
});

// ======================
// Server Start
// ======================
console.log(`Service ready on port ${PORT}`);
logAction('service_started');
const transport = new StdioServerTransport();
await server.connect(transport);