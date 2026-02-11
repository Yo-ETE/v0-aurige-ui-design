"""
Centralized error logging system for AURIGE.
Logs errors and info to /opt/aurige/data/errors.log with rotation.
"""
import logging
import sys
import traceback
from pathlib import Path
from logging.handlers import RotatingFileHandler
from datetime import datetime

# Global logger instance
_logger = None


def setup_error_logging(data_dir=None):
  """Configure error logger with rotation and proper formatting."""
  global _logger

  if data_dir is None:
    log_dir = Path("/opt/aurige/data")
  else:
    log_dir = Path(data_dir)

  log_dir.mkdir(parents=True, exist_ok=True)
  log_file = log_dir / "errors.log"

  _logger = logging.getLogger("aurige")
  _logger.setLevel(logging.DEBUG)

  # Avoid duplicate handlers
  if _logger.handlers:
    return _logger

  # Rotating file handler (10MB max, keep 5 backups)
  file_handler = RotatingFileHandler(
    log_file,
    maxBytes=10 * 1024 * 1024,
    backupCount=5,
    encoding='utf-8'
  )
  file_handler.setLevel(logging.DEBUG)

  formatter = logging.Formatter(
    '%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
  )
  file_handler.setFormatter(formatter)
  _logger.addHandler(file_handler)

  # Console handler
  console_handler = logging.StreamHandler(sys.stdout)
  console_handler.setLevel(logging.INFO)
  console_handler.setFormatter(formatter)
  _logger.addHandler(console_handler)

  return _logger


def _get_logger():
  """Get or create logger."""
  global _logger
  if _logger is None:
    setup_error_logging()
  return _logger


def log_info(message: str):
  """Log an info message."""
  _get_logger().info(message)


def log_error(message: str, exc: Exception = None):
  """Log an error message with optional exception traceback."""
  logger = _get_logger()
  if exc:
    tb = traceback.format_exc()
    logger.error(f"{message}\n{tb}")
  else:
    logger.error(message)
