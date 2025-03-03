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

// Helper function to format bytes to human-readable size
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

interface CacheStats {
  count: number;
  sizeBytes: number;
}

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
                    <FormLabel>LLM Provider</FormLabel>
                    <Select
                      aria-label="Select LLM Provider"
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
                    </Select>
                  </FormControl>
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
