import {
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Flex,
  Heading,
  Image,
  Skeleton,
  Tag,
  Text,
  Textarea,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/api/ApiClient';

const DailySuggestion = () => {
  const toast = useToast();

  const {
    data: suggestion,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['dailySuggestion'],
    queryFn: () => apiClient.getDailySuggestion(),
  });

  const handleCopyToClipboard = () => {
    if (!suggestion) return;

    const content = `${
      suggestion.suggestedCaption
    }\n\n${suggestion.suggestedHashtags.map((tag) => `#${tag}`).join(' ')}`;
    navigator.clipboard.writeText(content).then(
      () => {
        toast({
          title: 'Copied to clipboard',
          status: 'success',
          duration: 2000,
        });
      },
      (err) => {
        toast({
          title: 'Failed to copy',
          description: err.message,
          status: 'error',
          duration: 3000,
        });
      }
    );
  };

  return (
    <Box w="100%" maxW="container.xl" mx="auto">
      <Card>
        <CardHeader>
          <Heading size="md">Today's Instagram Pick</Heading>
        </CardHeader>
        <CardBody>
          {isLoading ? (
            <VStack spacing={4} align="stretch">
              <Skeleton height="400px" />
              <Skeleton height="20px" />
              <Skeleton height="100px" />
              <Skeleton height="40px" />
            </VStack>
          ) : error ? (
            <Text color="red.500">
              {error instanceof Error
                ? error.message
                : 'An error occurred while loading the suggestion'}
            </Text>
          ) : suggestion ? (
            <VStack spacing={4} align="stretch">
              <Image
                src={
                  suggestion.photo.path.startsWith('gdrive://')
                    ? `http://localhost:3001/api/photos/${suggestion.photo.id}/content`
                    : suggestion.photo.path
                }
                alt={suggestion.photo.aiMetadata.description}
                borderRadius="lg"
                objectFit="cover"
                maxH="500px"
              />

              <Text fontWeight="bold">Why this photo?</Text>
              <Text>{suggestion.reason}</Text>

              <Text fontWeight="bold">Suggested Caption</Text>
              <Textarea
                value={suggestion.suggestedCaption}
                isReadOnly
                rows={4}
              />

              <Text fontWeight="bold">Suggested Hashtags</Text>
              <Flex gap={2} flexWrap="wrap">
                {suggestion.suggestedHashtags.map((tag) => (
                  <Tag key={tag} colorScheme="teal">
                    #{tag}
                  </Tag>
                ))}
              </Flex>

              <Button colorScheme="teal" onClick={handleCopyToClipboard}>
                Copy to Clipboard
              </Button>
            </VStack>
          ) : (
            <Text>No suggestion available</Text>
          )}
        </CardBody>
      </Card>
    </Box>
  );
};

export default DailySuggestion;
