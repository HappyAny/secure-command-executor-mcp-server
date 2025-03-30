# Secure Command Executor

A robust command execution service with daily log rotation, designed to securely manage and execute system commands with safety checks and logging. And this README.md is written by DeepSeek V3.

## Features

- **Command Execution**: Execute system commands with optional arguments.
- **Safety Checks**: Warns and requires confirmation for dangerous commands.
- **Command Management**: Add, update, remove, enable, or disable commands.
- **Logging**: Daily log rotation with detailed action tracking.
- **Query Tools**: Query available commands and logs with filters.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/HappyAny/secure-command-executor-mcp-server.git
   cd secure-command-executor-mcp-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure the service:
   - Modify `commands.json` to define available commands.
   - Set environment variables (optional).

## Usage

### Starting the Service
```bash
node index.js --file commands.json --logs logs --port 3000
```

### Commands File
The `commands.json` file defines the available commands. Example:
```json
[
  {
    "name": "dir",
    "description": "List directory contents",
    "example": "dir /w",
    "dangerous": false,
    "enabled": true,
    "confirmationPrompt": "",
    "consequences": ""
  },
  {
    "name": "format",
    "description": "Format disk drive",
    "example": "format C:",
    "dangerous": true,
    "enabled": false,
    "confirmationPrompt": "This will PERMANENTLY erase all data. Confirm?",
    "consequences": "Permanent data loss"
  }
]
```

### API Endpoints

#### Execute a Command
```bash
curl -X POST http://localhost:3000/execute -H "Content-Type: application/json" -d '{"command": "dir", "args": "/w"}'
```

#### Query Commands
```bash
curl -X GET http://localhost:3000/queryCommands?filter=enabled&detailed=true
```

#### Manage Commands
```bash
curl -X POST http://localhost:3000/manageCommand -H "Content-Type: application/json" -d '{"action": "add", "name": "ping", "description": "Test network connection", "example": "ping example.com"}'
```

#### Query Logs
```bash
curl -X GET http://localhost:3000/queryLogs?limit=50&filter=failed
```

## Configuration

- **Environment Variables**:
  - `NODE_ENV`: Set to `production` for production mode.
  - `PORT`: Override the default port (3000).

- **Command-Line Arguments**:
  - `--file`: Path to the commands file (default: `commands.json`).
  - `--logs`: Path to the logs directory (default: `logs`).
  - `--port`: Port to run the service (default: 3000).

## Logging

Logs are stored in the specified directory with daily rotation. Each log file is named `YYYY-MM-DD.json`.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](https://choosealicense.com/licenses/mit/)
