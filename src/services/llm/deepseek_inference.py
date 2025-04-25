#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, Dict, Optional, Tuple

import torch
from PIL import Image
from transformers import (AutoConfig, AutoModelForCausalLM, AutoProcessor,
                          AutoTokenizer, PreTrainedModel, PreTrainedTokenizer)
from transformers.generation import GenerationConfig


def setup_gpu() -> str:
    """Configure GPU settings and return device"""
    if torch.backends.mps.is_available():
        device = 'mps'
    elif torch.cuda.is_available():
        device = 'cuda'
    else:
        device = 'cpu'
    print(f"Using device: {device}", file=sys.stderr)
    return device


def load_model(model_name: str, device: str) -> Tuple[PreTrainedModel, Any, PreTrainedTokenizer]:
    """
    Load the model and processors
    Args:
        model_name: Name/path of the model to load
        device: Device to load the model on ('cuda', 'mps', or 'cpu')
    Returns:
        Tuple of (model, processor, tokenizer)
    Raises:
        Exception: If model loading fails
    """
    try:
        print(
            f"Loading model configuration from {model_name}...", file=sys.stderr)
        config = AutoConfig.from_pretrained(model_name, trust_remote_code=True)

        print(
            f"Loading processor and tokenizer from {model_name}...", file=sys.stderr)
        processor = AutoProcessor.from_pretrained(
            model_name, trust_remote_code=True)
        tokenizer = AutoTokenizer.from_pretrained(
            model_name, trust_remote_code=True)

        print(f"Loading model from {model_name}...", file=sys.stderr)
        model = AutoModelForCausalLM.from_pretrained(
            model_name,
            torch_dtype=torch.float16 if device in [
                'cuda', 'mps'] else torch.float32,
            low_cpu_mem_usage=True,
            trust_remote_code=True
        )

        # Move model to device
        if device == 'mps':
            model = model.to(torch.device(device))
        else:
            model = model.to(device)

        model.generation_config = GenerationConfig.from_pretrained(model_name)
        return model, processor, tokenizer

    except Exception as e:
        print(f"Error loading model: {str(e)}", file=sys.stderr)
        raise


def analyze_image(image_path: str, model_name: str = "deepseek-ai/deepseek-vl-1.3b-chat") -> Optional[str]:
    """
    Analyze an image using a vision-language model
    Args:
        image_path: Path to the image file
        model_name: Name of the vision-language model to use
    Returns:
        str: Analysis result or None if analysis fails
    """
    try:
        # Validate image path
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"Image file not found: {image_path}")

        # Setup device
        device = setup_gpu()

        # Load model and processors
        model, processor, tokenizer = load_model(model_name, device)

        # Load and verify image
        try:
            image = Image.open(image_path)
            image = image.convert('RGB')
        except Exception as e:
            print(f"Error loading image: {str(e)}", file=sys.stderr)
            raise

        # Create prompt
        prompt = """Analyze this wildlife photo and provide the following information in a structured format:
        1. SUBJECTS: List all animals/wildlife subjects visible in the image
        2. COLORS: List dominant colors in the image
        3. PATTERNS: Describe any notable patterns or textures
        4. SEASON: If apparent from the environment or context. Indian seasons.
        5. ENVIRONMENT: Detailed description of the habitat/setting
        6. TAGS: Relevant keywords for searching (max 10)
        7. DESCRIPTION: A detailed, professional description of the photo
        Format each section clearly with headings."""

        # Process image and generate response
        try:
            inputs = processor(images=image, text=prompt,
                               return_tensors="pt").to(device)

            with torch.no_grad():  # Add no_grad context for inference
                output_ids = model.generate(
                    **inputs,
                    max_new_tokens=500,
                    min_length=100,
                    num_beams=5,
                    length_penalty=1.0,
                    temperature=0.7,
                )

            response = tokenizer.decode(
                output_ids[0], skip_special_tokens=True)
            print(response)  # Print to stdout for the Node.js process to capture
            return response

        except Exception as e:
            print(f"Error during inference: {str(e)}", file=sys.stderr)
            raise

    except Exception as e:
        print(f"Error in analyze_image: {str(e)}", file=sys.stderr)
        return None


def main():
    """Main entry point for the script"""
    if len(sys.argv) < 2:
        print(
            "Usage: python deepseek_inference.py <image_path> [model_name]", file=sys.stderr)
        sys.exit(1)

    image_path = sys.argv[1]
    model_name = sys.argv[2] if len(
        sys.argv) > 2 else "deepseek-ai/deepseek-vl-1.3b-chat"

    try:
        result = analyze_image(image_path, model_name)
        if result is None:
            sys.exit(1)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
