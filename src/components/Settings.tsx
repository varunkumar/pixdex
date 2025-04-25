import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  FormControl,
  FormLabel,
  Heading,
  Input,
  NumberDecrementStepper,
  NumberIncrementStepper,
  NumberInput,
  NumberInputField,
  NumberInputStepper,
  Select,
  Switch,
  Text,
  useDisclosure,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../services/api/ApiClient';
import { AppConfig, LLMProvider } from '../types/config';

const DEEPSEEK_MODELS = [
  {
    value: 'deepseek-ai/deepseek-janus-7b-chat-pro',
    label: 'Janus Pro 7B (Recommended)',
    gpuMemory: '8GB',
  },
  {
    value: 'deepseek-ai/deepseek-vl-1.3b-chat',
    label: 'Vision Language 1.3B (Lightweight)',
    gpuMemory: '4GB',
  },
  {
    value: 'deepseek-ai/janus-pro-35b-chat-complete',
    label: 'Janus Pro 35B (High Quality)',
    gpuMemory: '24GB',
  },
] as const;

const Settings = () => {
  const [config, setConfig] = useState<AppConfig>({
    llm: {
      provider: 'openai',
      apiKey: '',
    },
    storage: {
      localPaths: [],
      googleDrive: {
        enabled: false,
        credentialsPath: '',
      },
    },
    chromaDbPath: './data/chromadb',
    cacheDir: './data/cache',
  });

  const [cacheEnabled, setCacheEnabled] = useState(true);
  const toast = useToast();
  const queryClient = useQueryClient();

  // Use for clear cache confirmation dialog
  const { isOpen, onOpen, onClose } = useDisclosure();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Fetching the current configuration
  const { data: savedConfig, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => apiClient.getConfig(),
  });

  useEffect(() => {
    if (savedConfig) {
      setConfig(savedConfig);
    }
  }, [savedConfig]);

  // Mutation for saving configuration
  const updateConfigMutation = useMutation({
    mutationFn: (newConfig: AppConfig) => apiClient.updateConfig(newConfig),
    onSuccess: () => {
      toast({
        title: 'Settings saved',
        status: 'success',
        duration: 2000,
      });
    },
    onError: (error) => {
      toast({
        title: 'Error saving settings',
        description:
          error instanceof Error ? error.message : 'An error occurred',
        status: 'error',
        duration: 3000,
      });
    },
  });

  // Mutation for clearing the LLM cache
  const clearCacheMutation = useMutation({
    mutationFn: () => apiClient.clearLLMCache(),
    onSuccess: () => {
      toast({
        title: 'AI cache cleared',
        status: 'success',
        duration: 2000,
      });
      // Invalidate cache stats query to refresh stats
      queryClient.invalidateQueries({ queryKey: ['cacheStats'] });
    },
    onError: (error) => {
      toast({
        title: 'Error clearing cache',
        description:
          error instanceof Error ? error.message : 'An error occurred',
        status: 'error',
        duration: 3000,
      });
    },
  });

  // Mutation for toggling cache usage
  const toggleCacheMutation = useMutation({
    mutationFn: (enabled: boolean) => apiClient.toggleLLMCache(enabled),
    onSuccess: (data) => {
      setCacheEnabled(data.cacheEnabled);
      toast({
        title: `AI Cache ${data.cacheEnabled ? 'enabled' : 'disabled'}`,
        status: 'success',
        duration: 2000,
      });
    },
    onError: (error) => {
      toast({
        title: 'Error toggling cache',
        description:
          error instanceof Error ? error.message : 'An error occurred',
        status: 'error',
        duration: 3000,
      });
    },
  });

  const handleSave = () => {
    updateConfigMutation.mutate(config);
  };

  const handleToggleCache = () => {
    toggleCacheMutation.mutate(!cacheEnabled);
  };

  const handleClearCache = () => {
    clearCacheMutation.mutate();
    onClose();
  };

  if (isLoading) {
    return <Box>Loading...</Box>;
  }

  const selectedModel =
    DEEPSEEK_MODELS.find((model) => model.value === config.llm.modelName) ||
    DEEPSEEK_MODELS[0];

  return (
    <Box w="100%" maxW="container.xl" mx="auto">
      <VStack spacing={6} align="stretch">
        <Card>
          <CardHeader>
            <Heading size="md">Settings</Heading>
          </CardHeader>
          <CardBody>
            <VStack spacing={6} align="stretch">
              <Box>
                <Heading size="sm" mb={4}>
                  LLM Configuration
                </Heading>
                <VStack spacing={4}>
                  <FormControl id="llm-provider">
                    <FormLabel id="llm-provider-label">LLM Provider</FormLabel>
                    <Select
                      aria-label="Select LLM Provider"
                      aria-labelledby="llm-provider-label"
                      name="llm-provider"
                      value={config.llm.provider}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          llm: {
                            ...config.llm,
                            provider: e.target.value as LLMProvider,
                          },
                        })
                      }
                    >
                      <option value="openai">OpenAI</option>
                      <option value="grok3">Grok3</option>
                      <option value="deepseek">DeepSeek (Local)</option>
                    </Select>
                  </FormControl>

                  {config.llm.provider === 'deepseek' ? (
                    <>
                      <FormControl>
                        <FormLabel id="model-select-label">Model</FormLabel>
                        <Select
                          aria-label="Select DeepSeek Model"
                          aria-labelledby="model-select-label"
                          value={
                            config.llm.modelName || DEEPSEEK_MODELS[0].value
                          }
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              llm: { ...config.llm, modelName: e.target.value },
                            })
                          }
                        >
                          {DEEPSEEK_MODELS.map((model) => (
                            <option key={model.value} value={model.value}>
                              {model.label} (GPU: {model.gpuMemory})
                            </option>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl>
                        <FormLabel htmlFor="temperature">
                          Temperature (0.0 - 1.0)
                        </FormLabel>
                        <NumberInput
                          id="temperature"
                          min={0}
                          max={1}
                          step={0.1}
                          value={config.llm.temperature || 0.7}
                          onChange={(valueString) =>
                            setConfig({
                              ...config,
                              llm: {
                                ...config.llm,
                                temperature: parseFloat(valueString),
                              },
                            })
                          }
                        >
                          <NumberInputField />
                          <NumberInputStepper>
                            <NumberIncrementStepper />
                            <NumberDecrementStepper />
                          </NumberInputStepper>
                        </NumberInput>
                      </FormControl>
                      <Box>
                        <Text fontSize="sm" color="gray.600" mb={2}>
                          DeepSeek models run locally on your machine. Required
                          dependencies:
                        </Text>
                        <Text
                          as="code"
                          display="block"
                          p={2}
                          bg="gray.50"
                          borderRadius="md"
                          fontSize="sm"
                          mb={2}
                        >
                          pip install torch torchvision transformers pillow
                        </Text>
                        <Text fontSize="sm" color="gray.600">
                          Current model ({selectedModel.label}) requires{' '}
                          {selectedModel.gpuMemory} GPU memory. Models can run
                          on CPU but will be significantly slower.
                        </Text>
                      </Box>
                    </>
                  ) : (
                    <FormControl>
                      <FormLabel htmlFor="api-key">API Key</FormLabel>
                      <Input
                        id="api-key"
                        type="password"
                        value={config.llm.apiKey}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            llm: { ...config.llm, apiKey: e.target.value },
                          })
                        }
                      />
                    </FormControl>
                  )}
                </VStack>
              </Box>

              <Divider />

              <Box>
                <Heading size="sm" mb={4}>
                  Storage Configuration
                </Heading>
                <VStack spacing={4}>
                  <FormControl>
                    <FormLabel htmlFor="local-paths">
                      Local Photo Directories
                    </FormLabel>
                    <Input
                      id="local-paths"
                      placeholder="Comma-separated paths"
                      value={config.storage.localPaths.join(',')}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          storage: {
                            ...config.storage,
                            localPaths: e.target.value
                              .split(',')
                              .map((p) => p.trim()),
                          },
                        })
                      }
                    />
                  </FormControl>
                  <FormControl display="flex" alignItems="center">
                    <FormLabel htmlFor="enable-google-drive" mb={0}>
                      Enable Google Drive
                    </FormLabel>
                    <Switch
                      id="enable-google-drive"
                      isChecked={config.storage.googleDrive.enabled}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          storage: {
                            ...config.storage,
                            googleDrive: {
                              ...config.storage.googleDrive,
                              enabled: e.target.checked,
                            },
                          },
                        })
                      }
                    />
                  </FormControl>
                  {config.storage.googleDrive.enabled && (
                    <FormControl>
                      <FormLabel htmlFor="google-drive-credentials">
                        Google Drive Credentials Path
                      </FormLabel>
                      <Input
                        id="google-drive-credentials"
                        value={config.storage.googleDrive.credentialsPath}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            storage: {
                              ...config.storage,
                              googleDrive: {
                                ...config.storage.googleDrive,
                                credentialsPath: e.target.value,
                              },
                            },
                          })
                        }
                      />
                    </FormControl>
                  )}
                </VStack>
              </Box>

              <Divider />

              <Box>
                <Heading size="sm" mb={4}>
                  AI Cache Configuration
                </Heading>
                <VStack spacing={4} align="stretch">
                  <FormControl display="flex" alignItems="center">
                    <FormLabel htmlFor="enable-cache" mb={0}>
                      Enable AI Result Caching
                    </FormLabel>
                    <Switch
                      id="enable-cache"
                      isChecked={cacheEnabled}
                      onChange={handleToggleCache}
                      isDisabled={toggleCacheMutation.isPending}
                    />
                  </FormControl>

                  <Box>
                    <Text fontSize="sm" color="gray.600">
                      Caching AI results saves API costs by reusing previous
                      analysis results when analyzing the same image multiple
                      times.
                    </Text>
                  </Box>

                  <Box>
                    <Button
                      colorScheme="red"
                      size="sm"
                      onClick={onOpen}
                      isLoading={clearCacheMutation.isPending}
                    >
                      Clear AI Cache
                    </Button>
                  </Box>
                </VStack>
              </Box>

              <Button
                colorScheme="teal"
                onClick={handleSave}
                isLoading={updateConfigMutation.isPending}
              >
                Save Settings
              </Button>
            </VStack>
          </CardBody>
        </Card>
      </VStack>

      {/* Clear cache confirmation dialog */}
      <AlertDialog
        isOpen={isOpen}
        leastDestructiveRef={cancelRef}
        onClose={onClose}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader>Clear AI Cache</AlertDialogHeader>
            <AlertDialogBody>
              Are you sure you want to clear the AI cache? This will remove all
              cached AI analysis results and require re-processing images to
              generate new results.
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={cancelRef} onClick={onClose}>
                Cancel
              </Button>
              <Button
                colorScheme="red"
                onClick={handleClearCache}
                isLoading={clearCacheMutation.isPending}
                ml={3}
              >
                Clear Cache
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </Box>
  );
};

export default Settings;
