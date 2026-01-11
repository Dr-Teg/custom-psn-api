/**
 * Logging utility module
 * Provides structured logging functionality with different log levels
 */

const fs = require('fs');
const path = require('path');

// Log levels
const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

const LOG_LEVEL_PRIORITY = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

class Logger {
  /**
   * Initialize logger
   * @param {string} name - Logger name
   * @param {object} options - Configuration options
   */
  constructor(name = 'default', options = {}) {
    this.name = name;
    this.level = options.level || LOG_LEVELS.INFO;
    this.useConsole = options.useConsole !== false;
    this.useFile = options.useFile || false;
    this.logFile = options.logFile || 'app.log';
    this.logDir = options.logDir || 'logs';
    
    // Ensure log directory exists
    if (this.useFile && !fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Format timestamp in ISO format
   * @returns {string} Formatted timestamp
   */
  getTimestamp() {
    return new Date().toISOString();
  }

  /**
   * Format log message
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {object} meta - Additional metadata
   * @returns {string} Formatted log entry
   */
  formatMessage(level, message, meta = {}) {
    const timestamp = this.getTimestamp();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${this.name}] [${level}] ${message}${metaStr}`;
  }

  /**
   * Write log to file
   * @param {string} formattedMessage - Formatted log message
   */
  writeToFile(formattedMessage) {
    if (!this.useFile) return;
    
    const filePath = path.join(this.logDir, this.logFile);
    fs.appendFileSync(filePath, formattedMessage + '\n', 'utf8');
  }

  /**
   * Log message with specified level
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {object} meta - Additional metadata
   */
  log(level, message, meta = {}) {
    // Check if message should be logged based on level
    if (LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY[this.level]) {
      return;
    }

    const formattedMessage = this.formatMessage(level, message, meta);

    if (this.useConsole) {
      const consoleMethod = this.getConsoleMethod(level);
      consoleMethod(formattedMessage);
    }

    this.writeToFile(formattedMessage);
  }

  /**
   * Get appropriate console method for log level
   * @param {string} level - Log level
   * @returns {function} Console method
   */
  getConsoleMethod(level) {
    switch (level) {
      case LOG_LEVELS.ERROR:
        return console.error;
      case LOG_LEVELS.WARN:
        return console.warn;
      case LOG_LEVELS.DEBUG:
        return console.debug;
      case LOG_LEVELS.INFO:
      default:
        return console.log;
    }
  }

  /**
   * Log error message
   * @param {string} message - Error message
   * @param {object} meta - Additional metadata
   */
  error(message, meta = {}) {
    this.log(LOG_LEVELS.ERROR, message, meta);
  }

  /**
   * Log warning message
   * @param {string} message - Warning message
   * @param {object} meta - Additional metadata
   */
  warn(message, meta = {}) {
    this.log(LOG_LEVELS.WARN, message, meta);
  }

  /**
   * Log info message
   * @param {string} message - Info message
   * @param {object} meta - Additional metadata
   */
  info(message, meta = {}) {
    this.log(LOG_LEVELS.INFO, message, meta);
  }

  /**
   * Log debug message
   * @param {string} message - Debug message
   * @param {object} meta - Additional metadata
   */
  debug(message, meta = {}) {
    this.log(LOG_LEVELS.DEBUG, message, meta);
  }

  /**
   * Set log level
   * @param {string} level - Log level
   */
  setLevel(level) {
    if (LOG_LEVELS[level]) {
      this.level = level;
    }
  }
}

/**
 * Create a logger instance
 * @param {string} name - Logger name
 * @param {object} options - Configuration options
 * @returns {Logger} Logger instance
 */
function createLogger(name = 'default', options = {}) {
  return new Logger(name, options);
}

module.exports = {
  Logger,
  createLogger,
  LOG_LEVELS
};
