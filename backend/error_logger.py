"""
Centralized error logging system for AURIGE.
Logs all errors to /opt/aurige/data/errors.log with rotation.
"""
import logging
import sys
from pathlib import Path
from logging.handlers import RotatingFileHandler
from datetime import datetime

def setup_error_logger():
    """Configure error logger with rotation and proper formatting."""
    
    # Create logs directory if it doesn't exist
    log_dir = Path("/opt/aurige/data")
    log_dir.mkdir(parents=True, exist_ok=True)
    
    log_file = log_dir / "errors.log"
    
    # Configure logger
    logger = logging.getLogger("aurige_errors")
    logger.setLevel(logging.ERROR)
    
    # Rotating file handler (10MB max, keep 5 backups)
    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=10*1024*1024,  # 10MB
        backupCount=5,
        encoding='utf-8'
    )
    
    # Formatter with timestamp, level, module, and message
    formatter = logging.Formatter(
        '%(asctime)s [%(levelname)s] %(name)s:%(lineno)d - %(message)s\n'
        '%(exc_info)s\n'
        '=' * 80,
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    file_handler.setFormatter(formatter)
    
    logger.addHandler(file_handler)
    
    # Also log to console in development
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)
    
    return logger

def log_exception(logger, exception: Exception, context: str = ""):
    """Log an exception with full traceback and context."""
    import traceback
    
    error_msg = f"""
{'='*80}
EXCEPTION CAUGHT: {context}
Time: {datetime.now().isoformat()}
Type: {type(exception).__name__}
Message: {str(exception)}
Traceback:
{traceback.format_exc()}
{'='*80}
"""
    logger.error(error_msg)

def log_deployment_error(logger, stage: str, error: str):
    """Log deployment/installation errors."""
    error_msg = f"""
{'='*80}
DEPLOYMENT ERROR
Stage: {stage}
Time: {datetime.now().isoformat()}
Error: {error}
{'='*80}
"""
    logger.error(error_msg)

# Global logger instance
error_logger = setup_error_logger()
